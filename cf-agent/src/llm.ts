import type { Env } from "./types";
import { providerOf, type ModelInfo } from "./models";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const ENDPOINT: Record<Exclude<ModelInfo["provider"], "workers">, string> = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  zhipu: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
};

/** 同一隔离实例内轮询，429 / 失效密钥自动换下一把 */
const cursor: Record<string, number> = { groq: 0, dashscope: 0, zhipu: 0 };

export interface LlmOnce {
  text: string;
  finish: string;
  reasoningLen: number;
  usage: number;
}

function parseKeys(raw?: string): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const key = part.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function keysFor(env: Env, provider: string): string[] {
  if (provider === "groq") return parseKeys(env.GROQ_API_KEYS);
  if (provider === "dashscope") return parseKeys(env.DASHSCOPE_API_KEYS);
  if (provider === "zhipu") return parseKeys(env.ZHIPU_API_KEYS);
  return [];
}

export function providerReady(env: Env): Record<string, boolean> {
  return {
    groq: keysFor(env, "groq").length > 0,
    dashscope: keysFor(env, "dashscope").length > 0,
    zhipu: keysFor(env, "zhipu").length > 0,
    workers: true,
  };
}

function messageText(data: any): { text: string; finish: string; reasoningLen: number; usage: number } {
  const ch = data?.choices?.[0] ?? {};
  const msg = ch?.message ?? {};
  const content = msg?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => p?.text || "").join("") : "";
  return {
    text: text || "",
    finish: String(ch.finish_reason ?? ""),
    reasoningLen: String(msg.reasoning_content ?? msg.reasoning ?? "").length,
    usage: Number(data?.usage?.total_tokens ?? 0),
  };
}

async function postChat(
  url: string,
  key: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<{ status: number; data: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(3000, timeoutMs));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": UA,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调一家兼容接口。密钥轮询；json_object 被拒就去掉再试一次。
 * 404 直接抛出，让上层换模型，避免把同一把错误模型打满所有密钥。
 */
export async function runExternal(
  env: Env,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs: number,
  reasoning: boolean
): Promise<LlmOnce> {
  const provider = providerOf(model);
  if (provider === "workers") throw new Error("not_external");
  const keys = keysFor(env, provider);
  if (!keys.length) throw new Error("no_api_key");

  const url = ENDPOINT[provider];
  const start = cursor[provider] % keys.length;
  let lastStatus = 0;

  for (let n = 0; n < keys.length; n++) {
    const idx = (start + n) % keys.length;
    const base: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.15,
      max_tokens: maxTokens,
    };
    if (provider === "dashscope" && !reasoning) base.enable_thinking = false;

    let attempt = reasoning ? base : { ...base, response_format: { type: "json_object" } };
    let status = 0;
    let data: any = {};
    try {
      ({ status, data } = await postChat(url, keys[idx], attempt, timeoutMs));
      if (status === 400 && !reasoning) {
        ({ status, data } = await postChat(url, keys[idx], base, timeoutMs));
      }
    } catch (e) {
      // 超时或断网：换下一把，不把整条模型链打断
      console.log(`[llm] ${provider} ${model} key#${idx + 1} net`);
      lastStatus = 0;
      continue;
    }

    if (status === 200) {
      cursor[provider] = (idx + 1) % keys.length;
      return messageText(data);
    }

    lastStatus = status;
    console.log(`[llm] ${provider} ${model} key#${idx + 1} status=${status}`);
    if (status === 404) throw new Error("model_not_found");
    // 401 / 403 / 429 / 5xx：换下一把
  }

  throw new Error(`upstream_${lastStatus || "fail"}`);
}
