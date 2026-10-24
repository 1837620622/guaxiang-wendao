/**
 * 联网搜索（无 key，三源：搜狗 / DuckDuckGo HTML / Bing）
 * 重点：中文站点编码混乱（UTF-8 / GBK / GB2312 / Big5），
 * 统一走 arrayBuffer + charset 探测 + 乱码回退，避免"锟斤拷"。
 */
import { withTimeout } from "./util";

export interface WebResult {
  title: string;
  snippet: string;
  url: string;
  source: string;
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 编码安全抓取。只跟着留在最初那个主机上的跳转，不跟着搜到的外链走。 */
export async function fetchTextSafe(url: string, timeoutMs = 6000): Promise<string> {
  const first = new URL(url);
  if (first.protocol !== "https:") throw new Error("search_host");
  let current = first;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (let hop = 0; hop < 3; hop++) {
      if (current.hostname !== first.hostname) throw new Error("search_host");
      const res = await fetch(current.href, {
        headers: {
          "User-Agent": UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal: ctrl.signal,
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error("search_redirect");
        current = new URL(loc, current);
        continue;
      }
      const buf = await res.arrayBuffer();
      return decodeBuffer(buf, res.headers.get("content-type") || "");
    }
    throw new Error("search_redirect");
  } finally {
    clearTimeout(timer);
  }
}

/** 按 BOM / Content-Type / meta charset 探测，失败回退 gb18030 */
export function decodeBuffer(buf: ArrayBuffer, contentType = ""): string {
  const bytes = new Uint8Array(buf);

  // 1) BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buf);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    try { return new TextDecoder("utf-16le").decode(buf); } catch {}
  }

  // 2) Content-Type
  let charset = "";
  const m = contentType.match(/charset\s*=\s*["']?([\w-]+)/i);
  if (m) charset = m[1].toLowerCase();

  // 3) meta charset（先按 latin1 扫头部，不破坏字节）
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 4096));
    const mm = head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i);
    if (mm) charset = mm[1].toLowerCase();
  }

  if (charset === "gb2312" || charset === "gbk" || charset === "gb_2312-80") charset = "gb18030";
  if (charset === "big5" || charset === "big5-hkscs") charset = "big5";

  // 4) 解码
  let text = "";
  if (charset && charset !== "utf-8") {
    try {
      text = new TextDecoder(charset).decode(buf);
    } catch {
      text = "";
    }
  }
  if (!text) {
    try { text = new TextDecoder("utf-8").decode(buf); } catch { text = ""; }
  }

  // 5) 乱码回退：UTF-8 解出来一堆替换符，或中文占比异常低
  const bad = (text.match(/\uFFFD/g) || []).length;
  const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (bad > 12 || (text.length > 500 && han / text.length < 0.02 && /[\u4e00-\u9fff]/.test(contentType))) {
    try {
      const alt = new TextDecoder("gb18030").decode(buf);
      const altBad = (alt.match(/\uFFFD/g) || []).length;
      if (altBad < bad) text = alt;
    } catch {}
  }
  return text;
}

function stripTags(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** DuckDuckGo HTML 版 */
async function ddg(q: string, limit: number): Promise<WebResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=cn-zh`;
  const html = await fetchTextSafe(url, 6000);
  const out: WebResult[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < limit) {
    let link = m[1];
    const d = link.match(/uddg=([^&]+)/);
    if (d) { try { link = decodeURIComponent(d[1]); } catch {} }
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3] || "");
    if (!title || !link.startsWith("http")) continue;
    out.push({ title, snippet, url: link, source: "duckduckgo" });
  }
  return out;
}

/** Bing（国际版，cn.bing.com 在 Worker 出网时常被拦） */
async function bing(q: string, limit: number): Promise<WebResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&cc=CN&count=${limit * 2}`;
  const html = await fetchTextSafe(url, 6000);
  const out: WebResult[] = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const blk of blocks) {
    if (out.length >= limit) break;
    const t = blk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    const u = blk.match(/<h2[^>]*>[\s\S]*?href="(https?:\/\/[^"]+)"/);
    const p = blk.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (!t || !u) continue;
    out.push({
      title: stripTags(t[1]),
      snippet: stripTags(p ? p[1] : ""),
      url: u[1],
      source: "bing",
    });
  }
  return out;
}

/** 搜狗（Worker 出网实测可用） */
async function sogou(q: string, limit: number): Promise<WebResult[]> {
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(q)}`;
  let html = "";
  for (let i = 0; i < 2; i++) {
    try {
      html = await fetchTextSafe(url, 6000);
      if (html && html.length > 5000) break;
    } catch {}
  }
  const out: WebResult[] = [];
  const re = /<h3[^>]*class="[^"]*vr-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < limit) {
    const blk = m[1];
    const a = blk.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let link = a[1];
    if (link.startsWith("/")) link = "https://www.sogou.com" + link;
    // 只接受 http(s) 链接，别的协议（javascript:、data:）一律丢掉
    if (!/^https?:\/\//i.test(link)) continue;
    const title = stripTags(a[2]);
    if (!title) continue;
    out.push({ title, snippet: "", url: link, source: "sogou" });
  }
  return out;
}

/** 单个搜索源的时限。慢的源只会缺席，不拖住回答，也不连累已经回来的结果。 */
const SOURCE_MS = 8000;

/** 搜索：多源并发，失败互相兜底 */
export async function webSearch(query: string, limit = 5, sourceMs = SOURCE_MS): Promise<WebResult[]> {
  // 以前是整体 9 秒一刀切：一个慢源会让 Promise.race 直接返回空数组，已经到手的结果也丢了。
  const within = (p: Promise<WebResult[]>) =>
    withTimeout(p, sourceMs, "search_timeout").catch(() => [] as WebResult[]);
  const [c, a, b] = await Promise.all([
    within(sogou(query, limit)),
    within(ddg(query, limit)),
    within(bing(query, limit)),
  ]);
  // 相关性过滤：标题/摘要里至少出现一个查询词，挡掉搜索引擎的"默认页/广告页"
  const qKeys: string[] = [];
  for (const seg of query.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    if (seg.length <= 4) qKeys.push(seg);
    else for (let i = 0; i + 2 <= seg.length; i++) qKeys.push(seg.slice(i, i + 2));
  }
  const uniqKeys = [...new Set(qKeys)];
  const isRelevant = (r: WebResult) => {
    if (uniqKeys.length === 0) return true;
    const text = r.title + " " + r.snippet;
    const hit = uniqKeys.filter((k) => text.includes(k)).length;
    return hit >= Math.max(1, Math.ceil(uniqKeys.length / 3));
  };

  const merged: WebResult[] = [];
  const seen = new Set<string>();
  for (const r of [...c, ...a, ...b]) {
    if (!isRelevant(r)) continue;
    const key = r.url.replace(/[#?].*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(r);
    if (merged.length >= limit) break;
  }
  return merged;
}

/** 把联网结果压成提示词块 */
export function webPromptBlock(results: WebResult[]): string {
  if (!results.length) return "";
  const body = results
    .map((r, i) => `[W${i + 1}] ${r.title}\n${r.snippet}\n来源：${r.url}`)
    .join("\n\n");
  return `【联网结果（不能当成《改命记实录》。用到时 kind 写 web，refs 写 W 编号。不要把这里的吉凶断语抄进 daily）】
${body}`;
}
