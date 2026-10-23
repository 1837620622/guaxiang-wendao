import type { Env, AskResponse, Citation, AnswerPoint, Quote, SearchHit } from "./types";
import { retrieve, toCitations } from "./retrieve";
import { buildPrompt, buildSystemPrompt } from "./prompt";
import { MODELS, DEFAULT_MODEL, FALLBACK_CHAIN, isReasoning } from "./models";
import { resolveLocation, findLocationInText, listCities, geoPromptBlock } from "./geo";
import { webSearch, webPromptBlock, type WebResult } from "./websearch";
import { analyzeImage, base64ToBytes, visionPromptBlock, MAX_BYTES, type VisionResult } from "./vision";

const ALLOWED_MODELS = new Set(MODELS.map((m) => m.id));

/** 限流：每 IP 每分钟 / 每天 */
const RATE = { perMinute: 12, perDay: 60, searchPerMinute: 30 };

const SEC_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "SAMEORIGIN",
};

function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...SEC_HEADERS,
      ...extra,
    },
  });
}

function err(code: string, status: number) {
  return json({ error: code }, status);
}

function todayCN() {
  const now = new Date();
  const cn = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = cn.getUTCFullYear();
  const m = cn.getUTCMonth() + 1;
  const d = cn.getUTCDate();
  const week = "日一二三四五六"[cn.getUTCDay()];
  return `${y}年${m}月${d}日（星期${week}）`;
}

/** 短 hash，用于缓存键（避免 KV 512 字节上限） */
async function hashKey(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

/** 简单滑动窗口限流（KV 计数） */
async function rateLimit(env: Env, ip: string, kind: "ask" | "search"): Promise<{ ok: boolean; reason?: string }> {
  if (!env.CACHE) return { ok: true };
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const day = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const mKey = `rl:${kind}:m:${ip}:${minute}`;
  const dKey = `rl:${kind}:d:${ip}:${day}`;
  try {
    const [mRaw, dRaw] = await Promise.all([env.CACHE.get(mKey), env.CACHE.get(dKey)]);
    const mc = Number(mRaw || 0);
    const dc = Number(dRaw || 0);
    const lim = kind === "ask" ? RATE.perMinute : RATE.searchPerMinute;
    const dlim = kind === "ask" ? RATE.perDay : RATE.perDay * 4;
    if (mc >= lim) return { ok: false, reason: "too_many_requests_per_minute" };
    if (dc >= dlim) return { ok: false, reason: "too_many_requests_per_day" };
    await Promise.all([
      env.CACHE.put(mKey, String(mc + 1), { expirationTtl: 120 }),
      env.CACHE.put(dKey, String(dc + 1), { expirationTtl: 93600 }),
    ]);
    return { ok: true };
  } catch {
    return { ok: true }; // 限流故障时放行，不阻塞正常用户
  }
}

/** 从模型输出里抠出含 verdict 的 JSON 对象 */
function extractJSON(text: string): any | null {
  if (!text) return null;
  let t = text.trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();

  const candidates: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(t.slice(start, i + 1));
        start = -1;
      }
    }
  }
  // 优先含 verdict 的，其次最后一个平衡对象
  for (const cand of [...candidates].reverse()) {
    if (!/"verdict"\s*:/.test(cand)) continue;
    try { return JSON.parse(cand); } catch {}
  }
  for (const cand of [...candidates].reverse()) {
    try { return JSON.parse(cand); } catch {}
  }
  return null;
}

const norm = (s: string) => (s || "").replace(/[\s\u3000，。！？、；：""''（）()《》【】…—\-·]/g, "");

/**
 * 引用校验（严格）：
 *  - 整段归一化后必须能在原文里找到
 *  - 或按省略号切段，每段都必须按顺序命中
 */
function verifyQuote(q: string, source: string): boolean {
  if (!q || !source) return false;
  const a = norm(q);
  const b = norm(source);
  if (a.length < 6) return false;
  if (b.includes(a)) return true;

  const segs = q
    .split(/…+|\.{3,}|。{3,}|\s*……\s*/)
    .map(norm)
    .filter((s) => s.length >= 6);
  if (segs.length >= 2) {
    let pos = 0, ok = 0;
    for (const s of segs) {
      const idx = b.indexOf(s, pos);
      if (idx >= 0) { ok++; pos = idx + s.length; }
    }
    return ok === segs.length;
  }
  return false;
}

const clip = (s: unknown, n: number) => String(s ?? "").trim().slice(0, n);

function sanitizeCitations(cites: Citation[]): Citation[] {
  return cites.map(({ full, ...rest }) => rest);
}

/** 单次 AI 调用，返回正文 + 结束原因（用于诊断推理模型是否吃光预算） */
async function runOnce(
  env: Env,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs: number
): Promise<{ text: string; finish: string; reasoningLen: number; usage: number }> {
  const task = env.AI.run(model as any, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0.15,
  });
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("ai_timeout")), timeoutMs));
  const out: any = await Promise.race([task, timeout]);

  const o = out?.result ?? out ?? {};
  const ch = o?.choices?.[0] ?? {};
  const msg = ch?.message ?? {};
  const reasoningLen = String(msg.reasoning_content ?? msg.reasoning ?? "").length;
  return {
    text: extractText(out),
    finish: String(ch.finish_reason ?? ""),
    reasoningLen,
    usage: Number(o?.usage?.total_tokens ?? 0),
  };
}

/**
 * 带重试的 AI 调用：
 * 推理型模型的思考过程也占 max_tokens，预算不够时 content 为空、finish=length。
 * 这时把预算翻倍重试一次，而不是直接判失败。
 */
async function callLLM(
  env: Env,
  model: string,
  system: string,
  user: string,
  timeoutMs = 26000,
  deadline = Date.now() + 65000
): Promise<string> {
  // 推理型模型思考链也占额度，起步就给大预算
  const budgets = isReasoning(model) ? [5000, 9000] : [3000, 6000];

  for (let i = 0; i < budgets.length; i++) {
    if (deadline - Date.now() < 5000) break;
    const t0 = Date.now();
    const r = await runOnce(env, model, system, user, budgets[i], Math.min(timeoutMs, deadline - Date.now()));

    if (r.text && r.text.trim().length > 20) return r.text;

    const starved = r.finish === "length" || r.reasoningLen > 0;
    console.log(
      `[llm] ${model} budget=${budgets[i]} finish=${r.finish} text=${r.text.length} reason=${r.reasoningLen} tok=${r.usage} ${Date.now() - t0}ms`
    );
    if (!starved) break; // 不是预算问题，换预算也没用
  }
  return "";
}

/** 兼容 Workers AI 多种返回格式 */
function extractText(out: any): string {
  if (!out) return "";
  if (typeof out === "string") return out;
  const o = out.result ?? out;
  if (typeof o === "string") return o;
  if (o?.response) return String(o.response);
  const ch = o?.choices?.[0];
  if (ch?.message?.content) return String(ch.message.content);
  if (ch?.text) return String(ch.text);
  if (o?.output_text) return String(o.output_text);
  return ""; // 不再把 reasoning 当答案
}

/** 自由文本后置清洗：限长 + 去掉危险协议 */
function cleanText(s: unknown, max: number): string {
  return clip(s, max)
    .replace(/javascript\s*:/gi, "")
    .replace(/data\s*:\s*text\/html/gi, "");
}

async function handleAsk(request: Request, env: Env, ip: string): Promise<Response> {
  const t0 = Date.now();

  const cl = Number(request.headers.get("content-length") || 0);
  if (cl > 6 * 1024 * 1024) return err("payload_too_large", 413);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return err("invalid_json", 400);
  }
  if (typeof body?.question !== "string") return err("question_required", 400);
  const question = body.question.trim();
  const hasImg = typeof (body as any)?.image === "string" && (body as any).image.length > 0;
  if (!question && !hasImg) return err("question_required", 400);
  if (question.length > 400) return err("question_too_long", 400);
  if (!hasImg && (question.match(/[\u4e00-\u9fff]/g) || []).length < 2 && question.length < 4) {
    return json({ error: "question_too_short", hint: "至少输入两个字，例如「财位」「厨房」「大门」" }, 400);
  }

  const rl = await rateLimit(env, ip, "ask");
  if (!rl.ok) return json({ error: rl.reason, retryAfter: 60 }, 429);

  let topK = 6;
  if (body?.topK !== undefined) {
    const n = Number(body.topK);
    if (Number.isFinite(n)) topK = Math.min(Math.max(Math.trunc(n), 3), 10);
  }

  // 图片
  let vision: VisionResult | null = null;
  const imgRaw = typeof body?.image === "string" ? body.image : "";
  if (imgRaw) {
    const bytes = base64ToBytes(imgRaw);
    if (!bytes) return err("bad_image", 400);
    if (bytes.length > MAX_BYTES) return err("image_too_large", 413);

    // 同一张图 + 同一个 hint 复用识别结果，避免重复烧视觉模型算力
    const imgKey = `vis:v1:${await hashKey(imgRaw.slice(-800) + "|" + question.slice(0, 40))}`;
    if (env.CACHE) {
      try {
        const cached = await env.CACHE.get(imgKey, "json");
        if (cached) vision = cached as any;
      } catch {}
    }
    if (!vision) {
      try {
        vision = await analyzeImage(env, bytes, question);
        if (env.CACHE && vision.ok) {
          await env.CACHE.put(imgKey, JSON.stringify(vision), { expirationTtl: 7 * 86400 });
        }
      } catch (e: any) {
        console.error("vision failed", e);
        vision = { ok: false, text: "", model: "", ms: 0, error: String(e?.message ?? e) };
      }
    }
  }

  // 地理位置：显式传参优先，其次从问题文本里找城市名
  const explicitLoc = typeof body?.location === "string" ? body.location.trim().slice(0, 40) : "";
  const geo = explicitLoc ? resolveLocation(explicitLoc) : findLocationInText(question);

  // 模型白名单
  const reqModel = typeof body?.model === "string" && ALLOWED_MODELS.has(body.model) ? body.model : "";
  const primary = reqModel || env.MODEL || DEFAULT_MODEL;

  // 缓存键：模型 + topK + 问题指纹
  const fp = await hashKey(question);
  const historyArr = Array.isArray(body?.history) ? body.history : [];
  const cacheKey = `v24:ask:${primary}:${topK}:${geo ? geo.name : "-"}:${fp}${historyArr.length ? ":h" + historyArr.length : ""}${imgRaw ? ":img" : ""}`;
  if (env.CACHE) {
    try {
      const hit: any = await env.CACHE.get(cacheKey, "json");
      if (hit) return json({ ...hit, cached: true, elapsedMs: Date.now() - t0 });
    } catch (e) {
      console.error("cache get failed", e);
    }
  }

  const searchQuery = question || (vision?.ok ? vision.text.slice(0, 200) : "");

  let hits: SearchHit[];
  try {
    hits = await retrieve(env, searchQuery, topK);
  } catch (e) {
    console.error("retrieval failed", e);
    return err("retrieval_unavailable", 502);
  }

  // 联网：书里没结果，或问题本身要实时信息
  const realtimeIntent = /今天|今日|现在|今年|实时|新闻|天气|多少度|最近|最新|2025|2026|2027|当下/.test(question);
  const needWeb = hits.length === 0 || (realtimeIntent && hits.length < 3);
  let webResults: WebResult[] = [];
  if (needWeb && env.WEB_SEARCH !== "off") {
    const wKey = `web:v1:${await hashKey(question)}`;
    try {
      if (env.CACHE) {
        const cached = await env.CACHE.get(wKey, "json");
        if (cached) webResults = cached as WebResult[];
      }
      if (webResults.length === 0) {
        webResults = await webSearch(question, 5);
        if (env.CACHE && webResults.length) {
          await env.CACHE.put(wKey, JSON.stringify(webResults), { expirationTtl: 3600 });
        }
      }
    } catch (e) {
      console.error("web search failed", e);
    }
  }

  if (hits.length === 0 && webResults.length === 0) {
    const empty: AskResponse = {
      question,
      sourceLevel: "general",
      verdict: "无依据",
      conclusion: "书里和网上都没有找到能对应这个问题的内容。",
      points: [],
      quotes: [],
      missing: "换一种说法试试，例如：财位、聚财、大门、厨房、床头、文昌位、吉日。",
      citations: [],
      elapsedMs: Date.now() - t0,
      model: primary,
      geo: geo ? { name: geo.name, lat: geo.lat, lon: geo.lon, trueSolarOffsetMin: geo.trueSolarOffsetMin, declination: geo.declination } : undefined,
    };
    return json(empty);
  }

  const cites = toCitations(hits);

  const history = Array.isArray(body?.history)
    ? body.history
        .slice(-3)
        .map((h: any) => ({ q: cleanText(h?.q, 120), a: cleanText(h?.a, 160) }))
        .filter((h: any) => h.q && h.a)
    : [];

  const prompt = buildPrompt(
    question,
    cites,
    todayCN(),
    geo ? geoPromptBlock(geo) : "",
    webPromptBlock(webResults),
    history,
    vision ? visionPromptBlock(vision) : ""
  );

  const webLite = webResults.map((w, i) => ({
    n: `W${i + 1}`,
    title: w.title,
    snippet: w.snippet.slice(0, 220),
    url: w.url,
  }));

  let raw = "";
  let usedModel = primary;
  // 兜底链：首选 → 环境配置的兜底 → 最快最稳的 Llama 3.3
  const tryModels = [primary, env.FALLBACK_MODEL, ...FALLBACK_CHAIN].filter(Boolean) as string[];
  let lastErr: any = null;
  for (const m of [...new Set(tryModels)]) {
    try {
      raw = await callLLM(env, m, buildSystemPrompt(), prompt);
      usedModel = m;
      if (raw) break;
    } catch (e) {
      lastErr = e;
      console.error("model failed", m, e);
    }
  }

  if (!raw) {
    return json(
      {
        question,
        verdict: "解析失败",
        conclusion: "AI 暂时不可用，下面是检索到的原文，供你直接核对。",
        points: [],
        quotes: [],
        missing: "ai_unavailable",
        citations: sanitizeCitations(cites),
        elapsedMs: Date.now() - t0,
        model: usedModel,
        geo: geo ? { name: geo.name, lat: geo.lat, lon: geo.lon, trueSolarOffsetMin: geo.trueSolarOffsetMin, declination: geo.declination } : undefined,
      } satisfies AskResponse,
      200
    );
  }

  const parsed = extractJSON(raw);
  const n = cites.length;
  const byRef = new Map(cites.map((c) => [c.n, c]));

  let finalSourceLevel: AskResponse["sourceLevel"] = "general";

  let resp: AskResponse;
  if (!parsed) {
    resp = {
      question,
      verdict: "解析失败",
      conclusion: "模型没有按要求返回结构化结果，下面是检索到的原文，请直接核对。",
      points: [],
      quotes: [],
      missing: "",
      citations: sanitizeCitations(cites),
      elapsedMs: Date.now() - t0,
      model: usedModel,
      raw: cleanText(raw, 600),
      geo: geo ? { name: geo.name, lat: geo.lat, lon: geo.lon, trueSolarOffsetMin: geo.trueSolarOffsetMin, declination: geo.declination } : undefined,
    };
  } else {
    const verdictRaw = String(parsed.verdict ?? "").trim();
    const verdict: AskResponse["verdict"] =
      verdictRaw === "有依据" || verdictRaw === "部分依据" || verdictRaw === "无依据"
        ? (verdictRaw as any)
        : "部分依据";

    const points: AnswerPoint[] = Array.isArray(parsed.points)
      ? (parsed.points
          .map((p: any) => {
            const refs = Array.isArray(p?.refs)
              ? p.refs
                  .map((x: any) => {
                    if (typeof x === "string" && /^W\d+$/i.test(x.trim())) {
                      const wn = x.trim().toUpperCase();
                      const idx = Number(wn.slice(1));
                      return idx >= 1 && idx <= webResults.length ? wn : null;
                    }
                    const num = Number(x);
                    return Number.isInteger(num) && num >= 1 && num <= n ? num : null;
                  })
                  .filter((x: any) => x !== null)
              : [];
            const text = cleanText(p?.text, 120);
            if (!text) return null;
            const uniqRefs = [...new Set(refs)] as (number | string)[];

            let supported = false;
            for (const r of uniqRefs) {
              if (typeof r === "string") { supported = true; break; } // 联网引用存在即算有出处
              const src = byRef.get(r);
              if (!src) continue;
              const hay = (src.full || src.excerpt) || "";
              const grams = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
              if (grams.length === 0) { supported = hay.length > 0; break; }
              const hitCount = grams.filter((g) => hay.includes(g.slice(0, 2))).length;
              if (hitCount / grams.length >= 0.5) { supported = true; break; }
            }
            return { text, refs: uniqRefs, verified: supported && uniqRefs.length > 0 } as AnswerPoint;
          })
          .filter(Boolean) as AnswerPoint[])
      : [];

    const seenQuoteRef = new Set<number>();
    const quotes: Quote[] = Array.isArray(parsed.quotes)
      ? (parsed.quotes
          .map((q: any) => {
            const ref = Number(q?.ref);
            const quote = cleanText(q?.quote, 300);
            if (!Number.isInteger(ref) || ref < 1 || ref > n || !quote) return null;
            if (seenQuoteRef.has(ref)) return null;
            seenQuoteRef.add(ref);
            const src = byRef.get(ref);
            return { ref, quote, verified: src ? verifyQuote(quote, src.full || src.excerpt) : false } as Quote;
          })
          .filter(Boolean) as Quote[])
      : [];

    const hasVerifiedQuote = quotes.some((q) => q.verified);
    const hasRef = points.some((p) => p.verified);
    const usesWeb = points.some((p) => p.refs.some((r) => typeof r === "string"));
    const usesBook = points.some((p) => p.refs.some((r) => typeof r === "number"));
    let finalVerdict = verdict;
    if (verdict === "有依据" && !hasVerifiedQuote) finalVerdict = "部分依据";
    if (!hasRef && !hasVerifiedQuote) finalVerdict = "无依据";
    // 引文核对通过，但模型没归纳出可执行建议 → 最多降到"部分依据"
    if (finalVerdict === "无依据" && hasVerifiedQuote) finalVerdict = "部分依据";
    if (usesWeb && finalVerdict === "有依据") finalVerdict = "部分依据";
    finalSourceLevel = usesWeb && usesBook ? "book+web" : usesWeb ? "web" : usesBook ? "book" : "general";

    resp = {
      question,
      verdict: finalVerdict,
      conclusion: cleanText(parsed.conclusion, 80),
      points,
      quotes,
      missing: cleanText(parsed.missing, 200),
      citations: sanitizeCitations(cites),
      elapsedMs: Date.now() - t0,
      model: usedModel,
      sourceLevel: finalSourceLevel,
      web: webLite.length ? webLite : undefined,
      vision: vision ? { ok: vision.ok, text: vision.text, model: vision.model, ms: vision.ms, error: vision.error } : undefined,
      sourceNote: webLite.length ? "书里没有直接对应的内容，补充了联网结果，请注意甄别。" : undefined,
      geo: geo ? { name: geo.name, lat: geo.lat, lon: geo.lon, trueSolarOffsetMin: geo.trueSolarOffsetMin, declination: geo.declination } : undefined,
    };
  }

  if (env.CACHE && resp.verdict !== "解析失败") {
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(resp), { expirationTtl: 86400 });
    } catch (e) {
      console.error("cache put failed", e);
    }
  }
  return json(resp);
}

async function handleSearch(request: Request, env: Env, ip: string): Promise<Response> {
  const url = new URL(request.url);
  const qRaw = (url.searchParams.get("q") ?? "").trim();
  if (!qRaw) return err("q_required", 400);
  if (qRaw.length > 60) return err("q_too_long", 400);

  const rl = await rateLimit(env, ip, "search");
  if (!rl.ok) return json({ error: rl.reason, retryAfter: 60 }, 429);

  const nRaw = Number(url.searchParams.get("topK"));
  const topK = Number.isFinite(nRaw) ? Math.min(Math.max(Math.trunc(nRaw), 1), 8) : 5;

  let hits: SearchHit[];
  try {
    hits = await retrieve(env, qRaw, topK);
  } catch (e) {
    console.error("search retrieval failed", e);
    return err("retrieval_unavailable", 502);
  }

  const cites = toCitations(hits).map((c) => ({
    ...c,
    excerpt: c.excerpt.slice(0, 120) + (c.excerpt.length > 120 ? "…" : ""),
    full: undefined,
  }));
  return json({ question: qRaw, citations: cites });
}

/** health 结果缓存 5 分钟，避免 COUNT(*) 全表扫被刷 */
async function handleHealth(env: Env): Promise<Response> {
  const key = "health:v1";
  if (env.CACHE) {
    try {
      const cached = await env.CACHE.get(key, "json");
      if (cached) return json({ ...(cached as any), cached: true });
    } catch {}
  }
  try {
    const { results } = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM chapters) AS chapters"
    ).all();
    const data = {
      ok: true,
      ...(results?.[0] ?? {}),
      model: env.MODEL,
      models: MODELS.map((m) => m.id),
    };
    if (env.CACHE) {
      try { await env.CACHE.put(key, JSON.stringify(data), { expirationTtl: 300 }); } catch {}
    }
    return json(data);
  } catch (e) {
    console.error("health failed", e);
    return json({ ok: false, error: "db_unavailable" }, 500);
  }
}


/* ===== 原文阅读 API ===== */
let tocCache: { at: number; data: any } | null = null;

async function handleToc(env: Env): Promise<Response> {
  if (tocCache && Date.now() - tocCache.at < 3600_000) return json(tocCache.data);
  try {
    const { results } = await env.DB.prepare(
      "SELECT ord, no, title FROM chapters ORDER BY ord ASC"
    ).all();
    const data = { count: results?.length ?? 0, chapters: results ?? [] };
    tocCache = { at: Date.now(), data };
    return json(data);
  } catch (e) {
    console.error("toc failed", e);
    return err("db_unavailable", 500);
  }
}

async function handleChapter(env: Env, url: URL): Promise<Response> {
  const noRaw = url.searchParams.get("no");
  const ordRaw = url.searchParams.get("ord");
  if (!noRaw && !ordRaw) return err("no_required", 400);

  const key = `ch:v2:${noRaw ?? ""}:${ordRaw ?? ""}`;
  if (env.CACHE) {
    try {
      const hit = await env.CACHE.get(key);
      if (hit) return new Response(hit, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=86400", ...SEC_HEADERS } });
    } catch {}
  }

  try {
    const sql = noRaw
      ? "SELECT ord, no, title, body FROM chapters WHERE no = ? LIMIT 1"
      : "SELECT ord, no, title, body FROM chapters WHERE ord = ? LIMIT 1";
    const val = Number(noRaw ?? ordRaw);
    if (!Number.isFinite(val)) return err("bad_param", 400);
    const row = await env.DB.prepare(sql).bind(Math.trunc(val)).first<any>();
    if (!row) return err("chapter_not_found", 404);

    const prev = await env.DB.prepare("SELECT ord, no, title FROM chapters WHERE ord < ? ORDER BY ord DESC LIMIT 1").bind(row.ord).first<any>();
    const next = await env.DB.prepare("SELECT ord, no, title FROM chapters WHERE ord > ? ORDER BY ord ASC LIMIT 1").bind(row.ord).first<any>();
    const data = { ...row, prev: prev ?? null, next: next ?? null };

    if (env.CACHE) {
      try { await env.CACHE.put(key, JSON.stringify(data), { expirationTtl: 86400 }); } catch {}
    }
    return json(data, 200, { "Cache-Control": "public, max-age=86400" });
  } catch (e) {
    console.error("chapter failed", e);
    return err("db_unavailable", 500);
  }
}


/* ===== 反馈 & 统计 ===== */
async function handleFeedback(request: Request, env: Env): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return err("invalid_json", 400); }
  const q = cleanText(body?.question, 120);
  const v = body?.vote === "up" ? "up" : body?.vote === "down" ? "down" : "";
  const verdict = cleanText(body?.verdict, 10);
  if (!q || !v) return err("bad_feedback", 400);
  if (!env.CACHE) return json({ ok: false, reason: "no_cache" });

  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    // 1) 累计计数
    const counterKey = `fb:${v}:${day}`;
    const cur = Number((await env.CACHE.get(counterKey)) || 0);
    await env.CACHE.put(counterKey, String(cur + 1), { expirationTtl: 90 * 86400 });

    // 2) 问题热度（用于发现检索差的问题）
    const qKey = `q:${v}:${await hashKey(q)}`;
    await env.CACHE.put(qKey, JSON.stringify({ q, v, verdict, day, at: Date.now() }), { expirationTtl: 90 * 86400 });
  } catch (e) {
    console.error("feedback failed", e);
  }
  return json({ ok: true });
}

async function handleStats(env: Env): Promise<Response> {
  if (!env.CACHE) return json({ ok: false });
  const key = "stats:v1";
  try {
    const cached = await env.CACHE.get(key, "json");
    if (cached) return json({ ...(cached as any), cached: true });
  } catch {}

  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const out: any = { day, up: 0, down: 0, recent: [] as any[] };
  try {
    out.up = Number((await env.CACHE.get(`fb:up:${day}`)) || 0);
    out.down = Number((await env.CACHE.get(`fb:down:${day}`)) || 0);
    const list = await env.CACHE.list({ prefix: "q:", limit: 50 });
    for (const k of list.keys.slice(0, 20)) {
      const v = await env.CACHE.get(k.name, "json");
      if (v) out.recent.push(v);
    }
  } catch (e) {
    console.error("stats failed", e);
  }
  try { await env.CACHE.put(key, JSON.stringify(out), { expirationTtl: 300 }); } catch {}
  return json(out);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { ...SEC_HEADERS, "Allow": "GET,POST,OPTIONS" } });
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    if (url.pathname === "/api/ask" && request.method === "POST") return handleAsk(request, env, ip);
    if (url.pathname === "/api/search" && request.method === "GET") return handleSearch(request, env, ip);
    if (url.pathname === "/api/health") return handleHealth(env);
    if (url.pathname === "/api/models") return json({ default: env.MODEL || DEFAULT_MODEL, models: MODELS });
    if (url.pathname === "/api/vision" && request.method === "POST") {
      let vb: any;
      try { vb = await request.json(); } catch { return err("invalid_json", 400); }
      const raw = typeof vb?.image === "string" ? vb.image : "";
      if (!raw) return err("image_required", 400);
      const bytes = base64ToBytes(raw);
      if (!bytes) return err("bad_image", 400);
      if (bytes.length > MAX_BYTES) return err("image_too_large", 413);
      const r = await analyzeImage(env, bytes, String(vb?.hint ?? "").slice(0, 100));
      return json(r);
    }
    if (url.pathname === "/api/feedback" && request.method === "POST") return handleFeedback(request, env);
    if (url.pathname === "/api/stats") return handleStats(env);
    if (url.pathname === "/api/toc") return handleToc(env);
    if (url.pathname === "/api/chapter") return handleChapter(env, url);
    if (url.pathname === "/api/fetchtest") {
      const target = url.searchParams.get("url") || "";
      if (!target.startsWith("http")) return err("bad_url", 400);
      const t0 = Date.now();
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(target, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" },
          signal: ctrl.signal,
        });
        const buf = await res.arrayBuffer();
        return json({ ok: true, status: res.status, bytes: buf.byteLength, ms: Date.now() - t0, ct: res.headers.get("content-type") });
      } catch (e: any) {
        return json({ ok: false, error: String(e?.message ?? e), name: e?.name, ms: Date.now() - t0 }, 200);
      }
    }
    if (url.pathname === "/api/websearch") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return err("q_required", 400);
      try {
        const t0 = Date.now();
        const results = await webSearch(q, 5);
        return json({ q, ms: Date.now() - t0, count: results.length, results });
      } catch (e: any) {
        return json({ error: "websearch_failed", message: String(e?.message ?? e) }, 500);
      }
    }
    if (url.pathname === "/api/geo") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) return json({ cities: listCities() });
      const g = resolveLocation(q);
      return g ? json(g) : json({ error: "city_not_found", cities: listCities() }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};
