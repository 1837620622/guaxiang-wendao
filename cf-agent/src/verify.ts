/**
 * 模型输出的校验：引文能不能逐字对上原文、书中做法有没有出处、
 * 章号是不是真的存在、JSON 怎么从一段话里抠出来。
 * 全部是纯函数，单元测试见 tests/unit/verify.test.ts。
 */

/** 对比前统一去掉空白和标点，只剩字。 */
export const norm = (s: string) => (s || "").replace(/[\s　，。！？、；：""“”''‘’（）()《》【】…—\-·]/g, "");

/** 书中做法必须和所引段落共享这么多个连续汉字（忽略标点）。四个字太常见，证明不了出处。 */
export const ANCHOR_LEN = 6;

export function clip(s: unknown, n: number): string {
  return String(s ?? "").trim().slice(0, n);
}

/** 自由文本后置清洗：限长 + 去掉危险协议 */
export function cleanText(s: unknown, max: number): string {
  return clip(s, max)
    .replace(/javascript\s*:/gi, "")
    .replace(/data\s*:\s*text\/html/gi, "");
}

/** 从模型输出里抠出含 verdict 的 JSON 对象 */
export function extractJSON(text: string): any | null {
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

/**
 * 引用校验（严格）：
 *  - 整段归一化后必须能在原文里找到
 *  - 或按省略号切段，每段都必须按顺序命中
 */
export function verifyQuote(q: string, source: string): boolean {
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

/**
 * 书中做法是否和所引段落共享至少 ANCHOR_LEN 个连续汉字（标点不算）。
 * 两边都先去掉标点和空白，免得"床头，不要对着门"被逗号切成两段。
 */
export function pointTouchesSource(text: string, hay: string): boolean {
  if (!text || !hay) return false;
  const src = norm(hay);
  const runs = norm(text).match(/[一-鿿]+/g) || [];
  for (const run of runs) {
    for (let i = 0; i + ANCHOR_LEN <= run.length; i++) {
      if (src.includes(run.slice(i, i + ANCHOR_LEN))) return true;
    }
  }
  return false;
}

/** 日常段里冒出资料中不存在的章号时删掉，避免被看成书中引用。 */
export function scrubFakeChapter(text: string, chapters: Set<number>): string {
  return text
    .replace(/第\s*(\d+)\s*章(?:《[^》]{0,40}》)?(?:第\s*\d+\s*[–\-到至]\s*\d+\s*段)?/g, (all, n) =>
      chapters.has(Number(n)) ? all : ""
    )
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 整词匹配。southeast 不能再被 east 拆成正东。 */
function wordRe(body: string): RegExp {
  return new RegExp("(?<![a-z-])(?:" + body + ")(?![a-z-])", "i");
}

/** 英文提问时给检索补中文词，书是中文的。 */
export function searchText(question: string, lang: "zh" | "en"): string {
  const zhCount = (question.match(/[一-鿿]/g) || []).length;
  if (lang !== "en" && zhCount >= 2) return question;
  const pairs: [RegExp, string][] = [
    [wordRe("wealth|money|fortune|cash"), "财位"],
    [wordRe("living\\s*room|lounge"), "客厅"],
    [wordRe("bed(?:room)?|pillow"), "卧室 床头"],
    [wordRe("kitchen|stove"), "厨房 灶"],
    [wordRe("bath(?:room)?|toilet|restroom"), "卫生间"],
    [wordRe("mirror"), "镜子"],
    [wordRe("door|entrance|entry"), "大门 玄关"],
    [wordRe("fish(?:\\s*tank)?"), "鱼缸"],
    [wordRe("study|desk"), "书房"],
    [wordRe("move|moving|calendar"), "搬家 日子"],
    [wordRe("taboo|avoid|forbid"), "禁忌"],
    [wordRe("southeast|south-east"), "巽 东南"],
    [wordRe("northeast|north-east"), "艮 东北"],
    [wordRe("southwest|south-west"), "坤 西南"],
    [wordRe("northwest|north-west"), "乾 西北"],
    [wordRe("north"), "坎 北"],
    [wordRe("south"), "离 南"],
    [wordRe("east"), "震 东"],
    [wordRe("west"), "兑 西"],
    [wordRe("clutter|mess"), "杂物"],
  ];
  const extra = pairs.filter(([re]) => re.test(question)).map(([, zh]) => zh);
  return extra.length ? `${question} ${extra.join(" ")}` : question;
}
