import type { Env, AskResponse, Citation, AnswerPoint, Quote, SearchHit } from "./types";
import { retrieve, toCitations } from "./retrieve";
import { buildPrompt, buildSystemPrompt } from "./prompt";
import { MODELS, DEFAULT_MODEL, FALLBACK_CHAIN, isReasoning, providerOf } from "./models";
import { providerReady, runExternal } from "./llm";
import { resolveLocation, findLocationInText, listCities, geoPromptBlock, nearestCity, geoFromCoords, resolveEnglishCity } from "./geo";
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
  if (providerOf(model) !== "workers") {
    return runExternal(env, model, system, user, maxTokens, timeoutMs, isReasoning(model));
  }
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
  // 回答要写步骤和日常补充，JSON 比短句长，预算跟着加大
  const budgets = isReasoning(model) ? [6000, 10000] : [4500, 8000];

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

/** 书中做法是否复用了原文里连续四个字。解释可以写细，但不能和原文毫无交集。 */
function pointTouchesSource(text: string, hay: string): boolean {
  if (!text || !hay) return false;
  const runs = text.match(/[\u4e00-\u9fff]{4,}/g) || [];
  for (const run of runs) {
    for (let i = 0; i + 4 <= run.length; i++) {
      if (hay.includes(run.slice(i, i + 4))) return true;
    }
  }
  return false;
}

/** 日常段里冒出资料中不存在的章号时删掉，避免被看成书中引用。 */
function scrubFakeChapter(text: string, chapters: Set<number>): string {
  return text
    .replace(/第\s*(\d+)\s*章(?:《[^》]{0,40}》)?(?:第\s*\d+\s*[–\-到至]\s*\d+\s*段)?/g, (all, n) =>
      chapters.has(Number(n)) ? all : ""
    )
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 检索和模型都没给出可用正文时，仍交一段标明出处的过日子做法。 */
function everydayFallback(question: string, lang: "zh" | "en" = "zh"): { conclusion: string; daily: string; points: AnswerPoint[] } {
  const topic = clip(question, 18).replace(/\s+/g, " ") || (lang === "en" ? "this" : "这件事");
  if (lang === "en") {
    return {
      conclusion: `The book has no passage for “${topic}”. First make that spot walkable, lit and aired, and only then think about objects.`,
      daily:
        "This is not a line from the book. It is ordinary housekeeping, not a rule to spend money on. Stand in the spot you asked about and clear boxes, old clothes, broken appliances and luggage until an adult can stand there. Let daylight in, and do not keep the curtains shut all day. If there is a window, open it a little; if there is not, do not pile things over the air path. Doors, the passage and cupboard doors should open fully. Do not shove furniture into the corner. A fish tank or water feature needs a floor that can take the weight and no leak; if you are unsure, do not put it there. Do not aim a mirror at the bed or at the door. The kitchen needs its smoke to leave, and the bathroom needs its damp and smell to leave. Fix a broken door before you buy anything. After that, check the book again. If the book is silent, do not treat this as a reason to knock down a wall.",
      points: [
        { text: "Clear a space an adult can stand in. Do not leave boxes, broken appliances or luggage on the spot you asked about.", refs: [], verified: false, kind: "daily" },
        { text: "That spot needs daylight and air. Do not block the door or the passage with furniture.", refs: [], verified: false, kind: "daily" },
        { text: "Check leaks, weight and aim before a tank, a mirror or a large object. If unsure, leave it out. Do not open a wall for it.", refs: [], verified: false, kind: "daily" },
      ],
    };
  }
  return {
    conclusion: `「${topic}」对不上书中原文。先把相关的位置收拾到能走、能亮、能透气，再决定要不要摆东西。`,
    daily:
      "这一段不是《改命记实录》里的话，是过日子时的收拾法，不能当成书中依据，也不必为此花钱。先站到你问的那个位置：纸箱、旧衣、坏电器和暂时不用的行李清走，留出能站下一个大人的空。白天让这里见光，窗帘不要整天拉死；有窗就开一条缝换气，没有窗就不要再堆东西挡着风口。通往这里的门、过道和柜门要开得全，家具不要顶死墙角。要放水景或鱼缸，先看楼板承重和会不会漏，没有把握就先不放。镜子不要正对着床头，也不要正对着房门。厨房看油烟能不能排出去，卫生间看潮气和异味，门扇坏了先修。做完这些，再回书里对原文；对不上的，就不要当成规矩去改结构、砸墙或买摆件。",
    points: [
      { text: "先清出能站人的空。纸箱、坏电器和暂时不用的行李不要占着你问的这个位置。", refs: [], verified: false, kind: "daily" },
      { text: "这个位置要见光、能换气。门和过道不要被家具顶死，人要走得顺。", refs: [], verified: false, kind: "daily" },
      { text: "鱼缸、镜子和大件先看漏水、承重和朝向。没有把握就先不放，也不要为此砸墙。", refs: [], verified: false, kind: "daily" },
    ],
  };
}

/** 英文提问时给检索补中文词，书是中文的。 */
function searchText(question: string, lang: "zh" | "en"): string {
  const zhCount = (question.match(/[\u4e00-\u9fff]/g) || []).length;
  if (lang !== "en" && zhCount >= 2) return question;
  const pairs: [RegExp, string][] = [
    [/wealth|money|fortune|cash/i, "财位"],
    [/living\s*room|lounge/i, "客厅"],
    [/bed|pillow|bedroom/i, "卧室 床头"],
    [/kitchen|stove/i, "厨房 灶"],
    [/bath|toilet|restroom/i, "卫生间"],
    [/mirror/i, "镜子"],
    [/door|entrance|entry/i, "大门 玄关"],
    [/fish/i, "鱼缸"],
    [/study|desk/i, "书房"],
    [/mov(?:e|ing)|calendar/i, "搬家 日子"],
    [/taboo|avoid|forbid/i, "禁忌"],
    [/north/i, "坎 北"],
    [/south/i, "离 南"],
    [/east/i, "震 东"],
    [/west/i, "兑 西"],
    [/southeast|south-east/i, "巽 东南"],
    [/northeast|north-east/i, "艮 东北"],
    [/southwest|south-west/i, "坤 西南"],
    [/northwest|north-west/i, "乾 西北"],
    [/clutter|mess/i, "杂物"],
  ];
  const extra = pairs.filter(([re]) => re.test(question)).map(([, zh]) => zh);
  return extra.length ? `${question} ${extra.join(" ")}` : question;
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
  const lang: "zh" | "en" = body?.lang === "en" ? "en" : "zh";
  const facingRaw = Number(body?.facing);
  const facing = Number.isFinite(facingRaw) && facingRaw >= 0 && facingRaw < 360 ? Math.round(facingRaw) : null;

  // 模型白名单
  const reqModel = typeof body?.model === "string" && ALLOWED_MODELS.has(body.model) ? body.model : "";
  const primary = reqModel || env.MODEL || DEFAULT_MODEL;

  // 缓存键带上模型、历史正文和图片指纹，避免换图或换上下文撞上一条答案
  const fp = await hashKey(question);
  const historyArr = Array.isArray(body?.history) ? body.history : [];
  const histFp = historyArr.length
    ? await hashKey(historyArr.map((h: any) => `${h?.q ?? ""}|${h?.a ?? ""}`).join("\n"))
    : "-";
  const imgFp = imgRaw ? await hashKey(imgRaw.slice(0, 240) + "|" + imgRaw.slice(-800)) : "-";
  const cacheKey = `v28:ask:${lang}:${primary}:${topK}:${geo ? geo.name : "-"}:${facing ?? "-"}:${fp}:${histFp}:${imgFp}`;
  if (env.CACHE) {
    try {
      const hit: any = await env.CACHE.get(cacheKey, "json");
      if (hit) return json({ ...hit, cached: true, elapsedMs: Date.now() - t0 });
    } catch (e) {
      console.error("cache get failed", e);
    }
  }

  const searchQuery = searchText(question, lang) || (vision?.ok ? vision.text.slice(0, 200) : "");

  let hits: SearchHit[];
  try {
    hits = await retrieve(env, searchQuery, topK);
  } catch (e) {
    console.error("retrieval failed", e);
    return err("retrieval_unavailable", 502);
  }

  // 联网：书里没结果，或问题本身要实时信息
  const realtimeIntent = /今天|今日|现在|今年|实时|新闻|天气|多少度|最近|最新|2025|2026|2027|当下|today|this year|right now/i.test(question);
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

  // 书里没翻到也继续问模型，让它写明「书中无据」后再补日常做法
  const cites = toCitations(hits);

  const history = Array.isArray(body?.history)
    ? body.history
        .slice(-3)
        .map((h: any) => ({ q: cleanText(h?.q, 120), a: cleanText(h?.a, 280) }))
        .filter((h: any) => h.q && h.a)
    : [];

  let geoBlock = geo ? geoPromptBlock(geo) : "";
  if (facing !== null) {
    geoBlock += `\n用户站在门内、面朝门外，手机指南针约 ${facing}°。这是他自己量的，不是书中原文。没有原文对应时，不要把这个度数写成吉凶。`;
  }
  const prompt = buildPrompt(
    question,
    cites,
    todayCN(),
    geoBlock,
    webPromptBlock(webResults),
    history,
    vision ? visionPromptBlock(vision) : "",
    lang
  );

  const webLite = webResults.map((w, i) => ({
    n: `W${i + 1}`,
    title: w.title,
    snippet: w.snippet.slice(0, 220),
    url: w.url,
  }));

  let raw = "";
  let usedModel = primary;
  let parsed: any = null;
  // 兜底链：首选 → 环境配置的兜底 → Workers。正文不是合法 JSON 就换下一家。
  const tryModels = [primary, env.FALLBACK_MODEL, ...FALLBACK_CHAIN].filter(Boolean) as string[];
  for (const m of [...new Set(tryModels)]) {
    try {
      const text = await callLLM(env, m, buildSystemPrompt(lang), prompt);
      if (!text) continue;
      const got = extractJSON(text);
      raw = text;
      usedModel = m;
      if (!got) {
        console.log(`[llm] json miss ${m}`);
        continue;
      }
      parsed = got;
      break;
    } catch (e) {
      console.error("model failed", m, e);
    }
  }

  const geoOut = geo
    ? { name: geo.name, lat: geo.lat, lon: geo.lon, trueSolarOffsetMin: geo.trueSolarOffsetMin, declination: geo.declination }
    : undefined;
  const chapters = new Set(cites.map((c) => c.ch));

  const dailyOnly = (): AskResponse => {
    const fb = everydayFallback(question, lang);
    return {
      question,
      sourceLevel: "general",
      verdict: "无依据",
      conclusion: fb.conclusion,
      points: fb.points,
      quotes: [],
      missing: lang === "en" ? "No passage in the book matches this." : "书里没翻到能对上的原文。",
      daily: fb.daily,
      citations: [],
      elapsedMs: Date.now() - t0,
      model: usedModel,
      sourceNote: lang === "en"
        ? "Nothing in the book matches this. The notes below are everyday practice, not evidence from the book."
        : "这条对不上书中原文。下面是日常经验，不是《改命记实录》里的依据。",
      web: webLite.length ? webLite : undefined,
      geo: geoOut,
    };
  };

  let resp: AskResponse;
  if (!raw) {
    resp = cites.length
      ? {
          question,
          verdict: "解析失败",
          conclusion: "AI 暂时不可用，下面是检索到的原文，供你直接核对。",
          points: [],
          quotes: [],
          missing: "ai_unavailable",
          citations: sanitizeCitations(cites),
          elapsedMs: Date.now() - t0,
          model: usedModel,
          geo: geoOut,
        }
      : dailyOnly();
  } else if (!parsed) {
    resp = cites.length
      ? {
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
          geo: geoOut,
        }
      : dailyOnly();
  } else {
    const n = cites.length;
    const byRef = new Map(cites.map((c) => [c.n, c]));
    const verdictRaw = String(parsed.verdict ?? "").trim();
    const verdict: AskResponse["verdict"] =
      verdictRaw === "有依据" || verdictRaw === "部分依据" || verdictRaw === "无依据"
        ? (verdictRaw as any)
        : "部分依据";

    const buckets: Record<"book" | "daily" | "web", AnswerPoint[]> = { book: [], daily: [], web: [] };
    const limits = { book: 5, daily: 4, web: 3 };
    if (Array.isArray(parsed.points)) {
      for (const p of parsed.points) {
        const text0 = cleanText(p?.text, 360);
        if (!text0) continue;
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
        let bookRefs = [...new Set(refs.filter((r: number | string) => typeof r === "number"))] as number[];
        const webRefs = [...new Set(refs.filter((r: number | string) => typeof r === "string"))] as string[];
        const asked = String(p?.kind ?? "").trim();
        let kind: "book" | "daily" | "web" =
          asked === "daily" || asked === "web" || asked === "book" ? asked : "book";
        if (kind !== "daily" && webRefs.length && bookRefs.length === 0) kind = "web";
        if (kind === "book" && bookRefs.length === 0) {
          for (const c of cites) {
            if (pointTouchesSource(text0, c.full || c.excerpt)) {
              bookRefs = [c.n];
              break;
            }
          }
          if (bookRefs.length === 0) kind = "daily";
        }
        let text = text0;
        let verified = false;
        let outRefs: (number | string)[] = [];
        if (kind === "web") {
          verified = webRefs.length > 0;
          outRefs = webRefs;
          if (!verified) kind = "daily";
        }
        if (kind === "book") {
          verified = bookRefs.some((r) => {
            const src = byRef.get(r);
            return src ? pointTouchesSource(text, src.full || src.excerpt) : false;
          });
          outRefs = bookRefs;
        }
        if (kind === "daily") {
          text = scrubFakeChapter(text, chapters);
          verified = false;
          outRefs = [];
        }
        if (!text || buckets[kind].length >= limits[kind]) continue;
        buckets[kind].push({ text, refs: outRefs, verified, kind });
      }
    }
    const points = [...buckets.book, ...buckets.web, ...buckets.daily];

    const seenQuoteRef = new Set<number>();
    const quotes: Quote[] = Array.isArray(parsed.quotes)
      ? (parsed.quotes
          .map((q: any) => {
            const ref = Number(q?.ref);
            const quote = cleanText(q?.quote, 420);
            if (!Number.isInteger(ref) || ref < 1 || ref > n || !quote) return null;
            if (seenQuoteRef.has(ref)) return null;
            seenQuoteRef.add(ref);
            const src = byRef.get(ref);
            return { ref, quote, verified: src ? verifyQuote(quote, src.full || src.excerpt) : false } as Quote;
          })
          .filter(Boolean) as Quote[])
      : [];

    const hasVerifiedQuote = quotes.some((q) => q.verified);
    const hasVerifiedBookPoint = points.some((p) => p.kind === "book" && p.verified);
    const usesWeb = points.some((p) => p.kind === "web");
    const usesBook = hasVerifiedBookPoint || hasVerifiedQuote;
    let finalVerdict = verdict;
    if (verdict === "有依据" && !hasVerifiedQuote) finalVerdict = "部分依据";
    if (!hasVerifiedBookPoint && !hasVerifiedQuote) finalVerdict = "无依据";
    if (finalVerdict === "无依据" && hasVerifiedQuote) finalVerdict = "部分依据";
    if (usesWeb && finalVerdict === "有依据") finalVerdict = "部分依据";
    const finalSourceLevel: AskResponse["sourceLevel"] =
      usesWeb && usesBook ? "book+web" : usesWeb ? "web" : usesBook ? "book" : "general";

    let dailyText = scrubFakeChapter(cleanText(parsed.daily, 700), chapters);
    let conclusion = cleanText(parsed.conclusion, 280);
    let missing = scrubFakeChapter(cleanText(parsed.missing, 240), chapters);
    if ((finalVerdict === "无依据" || finalVerdict === "部分依据") && !dailyText) {
      const fb = everydayFallback(question, lang);
      dailyText = fb.daily;
      if (!points.some((p) => p.kind === "daily")) points.push(...fb.points);
      if (conclusion.length < 20) conclusion = fb.conclusion;
      if (!missing) missing = lang === "en" ? "The book does not cover every step. Everyday practice is below." : "书中没写全的步骤，已按日常经验补在下面。";
    }

    const bookBacked = finalVerdict === "有依据" || finalVerdict === "部分依据";
    const hasDaily = Boolean(dailyText) || points.some((p) => p.kind === "daily");
    let sourceNote = "";
    if (lang === "en") {
      if (bookBacked && hasDaily) sourceNote = "What matches the book is marked with chapter and paragraph. Anything else is everyday practice, not a line from the book.";
      else if (bookBacked) sourceNote = "The steps below follow the passages found. Open a quote to check the wording.";
      else if (hasDaily) sourceNote = "Nothing in the book matches this. The notes below are everyday practice, not evidence from the book.";
      if (webLite.length) sourceNote = (sourceNote ? sourceNote + " " : "") + "Web snippets are listed apart and are not the book.";
    } else {
      if (bookBacked && hasDaily) sourceNote = "对得上原文的写法已经标了章节。书里没写到的，另起一段日常经验，不要当成书里的话。";
      else if (bookBacked) sourceNote = "下面的做法按检索到的原文来，原句可以展开核对。";
      else if (hasDaily) sourceNote = "这条对不上书中原文。下面是日常经验，不是《改命记实录》里的依据。";
      if (webLite.length) sourceNote = (sourceNote ? sourceNote + " " : "") + "联网内容单独列出，不能当成书中依据。";
    }

    resp = {
      question,
      verdict: finalVerdict,
      conclusion,
      points,
      quotes,
      missing,
      daily: dailyText || undefined,
      citations: sanitizeCitations(cites),
      elapsedMs: Date.now() - t0,
      model: usedModel,
      sourceLevel: finalSourceLevel,
      web: webLite.length ? webLite : undefined,
      vision: vision ? { ok: vision.ok, text: vision.text, model: vision.model, ms: vision.ms, error: vision.error } : undefined,
      sourceNote: sourceNote || undefined,
      geo: geoOut,
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
  const key = "health:v2";
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
      providers: providerReady(env),
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

/** 只返回城市和校方位用的偏差，不回传 IP，也不落库。 */
function whereFromEdge(request: Request, url: URL) {
  const cf = (request as Request & { cf?: Record<string, unknown> }).cf || {};
  const qLat = Number(url.searchParams.get("lat"));
  const qLon = Number(url.searchParams.get("lon"));
  const hasGps = Number.isFinite(qLat) && Number.isFinite(qLon) && Math.abs(qLat) <= 90 && Math.abs(qLon) <= 180;
  const cfLat = Number(cf.latitude);
  const cfLon = Number(cf.longitude);
  const cfCity = String(cf.city || "");
  const region = String(cf.region || "");
  const country = String(cf.country || "");
  const timezone = String(cf.timezone || "");

  let how: "gps" | "ip" | "none" = "none";
  let g = null as ReturnType<typeof resolveLocation>;
  if (hasGps) {
    how = "gps";
    g = nearestCity(qLat, qLon, 80) || geoFromCoords(cfCity || region || "当地", qLat, qLon, region);
  } else if (Number.isFinite(cfLat) && Number.isFinite(cfLon)) {
    how = "ip";
    g = nearestCity(cfLat, cfLon, 160) || resolveEnglishCity(cfCity) || geoFromCoords(cfCity || region || "当地", cfLat, cfLon, region);
  } else {
    g = resolveEnglishCity(cfCity) || resolveLocation(cfCity);
    how = g ? "ip" : "none";
  }

  return {
    how,
    country,
    region,
    timezone,
    city: g?.name || "",
    geo: g,
  };
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
    if (url.pathname === "/api/models") {
      return json({ default: env.MODEL || DEFAULT_MODEL, models: MODELS, providers: providerReady(env) });
    }
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
    if (url.pathname === "/api/where" && request.method === "GET") {
      return json(whereFromEdge(request, url));
    }

    return env.ASSETS.fetch(request);
  },
};
