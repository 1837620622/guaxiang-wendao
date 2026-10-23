export interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  CACHE?: KVNamespace;
  MODEL?: string;
  FALLBACK_MODEL?: string;
  BOOK_TITLE?: string;
  BOOK_AUTHOR?: string;
  WEB_SEARCH?: string;
}

export interface Chunk {
  ord?: number;
  id: number;
  ch: number;
  title: string;
  p0: number;
  p1: number;
  text: string;
}

export interface SearchHit extends Chunk {
  score: number;
  id: number;
}

export interface Citation {
  n: number;
  ch: number;
  title: string;
  p0: number;
  p1: number;
  excerpt: string;
  /** 完整原文，仅后端校验用，返回前端前会删掉 */
  full?: string;
}

export interface AnswerPoint {
  text: string;
  /** 数字 = 书内引用；"W1" = 联网引用 */
  refs: (number | string)[];
  /** refs 是否全部合法 */
  verified: boolean;
}

export interface Quote {
  ref: number;
  quote: string;
  /** quote 是否真的出现在对应原文中 */
  verified: boolean;
}

export type SourceLevel = "book" | "book+web" | "web" | "general";

export interface WebResultLite {
  n: string;
  title: string;
  snippet: string;
  url: string;
}

export interface AskResponse {
  question: string;
  /** 答案的证据等级 */
  sourceLevel?: SourceLevel;
  verdict: "有依据" | "部分依据" | "无依据" | "解析失败";
  conclusion: string;
  points: AnswerPoint[];
  quotes: Quote[];
  missing: string;
  citations: Citation[];
  elapsedMs: number;
  model: string;
  cached?: boolean;
  raw?: string;
  geo?: {
    name: string;
    lat: number;
    lon: number;
    trueSolarOffsetMin: number;
    declination: number;
  };
  web?: WebResultLite[];
  vision?: { ok: boolean; text: string; model: string; ms: number; error?: string };
  /** 联网/兜底说明 */
  sourceNote?: string;
}
