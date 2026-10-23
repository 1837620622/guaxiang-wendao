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
  /** 逗号或空白分隔，多把密钥轮询。不要写进仓库。 */
  GROQ_API_KEYS?: string;
  DASHSCOPE_API_KEYS?: string;
  ZHIPU_API_KEYS?: string;
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
  /** 数字 = 书内引用；"W1" = 联网引用；日常做法不挂编号 */
  refs: (number | string)[];
  /** 书中或联网出处是否对得上。日常做法恒为 false */
  verified: boolean;
  /** book 必须能对上原文；web 只来自联网；daily 是书外的过日子做法 */
  kind?: "book" | "daily" | "web";
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
  /** 书里没写到时的日常做法。页面上必须标明不是原文 */
  daily?: string;
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
