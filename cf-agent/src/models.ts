/** 已实测可用的文本模型。provider=workers 走 Workers AI，其余走 OpenAI 兼容接口。 */
export interface ModelInfo {
  id: string;
  label: string;
  note: string;
  group: "推荐" | "通义" | "智谱" | "推理" | "兜底";
  provider: "groq" | "dashscope" | "zhipu" | "workers";
  /** 思考链会吃掉 max_tokens，需要更大预算 */
  reasoning?: boolean;
}

export const MODELS: ModelInfo[] = [
  { id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B", note: "Groq · 默认", group: "推荐", provider: "groq" },
  { id: "qwen-plus", label: "通义 Plus", note: "DashScope · 中文稳", group: "通义", provider: "dashscope" },
  { id: "qwen-turbo", label: "通义 Turbo", note: "DashScope · 易限流", group: "通义", provider: "dashscope" },
  { id: "glm-4-flash", label: "GLM-4 Flash", note: "智谱 · 快", group: "智谱", provider: "zhipu" },
  { id: "glm-4-flash-250414", label: "GLM-4 Flash 0414", note: "智谱 · 快", group: "智谱", provider: "zhipu" },

  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", note: "Groq · 会先想", group: "推理", provider: "groq", reasoning: true },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", note: "Groq · 会先想", group: "推理", provider: "groq", reasoning: true },
  { id: "deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash", note: "DashScope · 会先想", group: "推理", provider: "dashscope", reasoning: true },
  { id: "glm-4.5-flash", label: "GLM-4.5 Flash", note: "智谱 · 会先想", group: "推理", provider: "zhipu", reasoning: true },

  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B", note: "Workers · 兜底", group: "兜底", provider: "workers" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1", note: "Workers · 兜底", group: "兜底", provider: "workers" },
  { id: "@cf/deepseek-ai/deepseek-v4-flash-0731", label: "DeepSeek V4 Flash", note: "Workers · 兜底", group: "兜底", provider: "workers" },
  { id: "@cf/zai-org/glm-4.7-flash", label: "GLM-4.7 Flash", note: "Workers · 兜底", group: "兜底", provider: "workers" },
];

export const DEFAULT_MODEL = "qwen/qwen3.8-27b";

/** 失败后换模型的顺序：Groq → 通义 → 智谱 → Workers */
export const FALLBACK_CHAIN = [
  "qwen/qwen3.8-27b",
  "qwen-plus",
  "glm-4-flash",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
];

export function findModel(modelId: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === modelId);
}

export function providerOf(modelId: string): ModelInfo["provider"] {
  return findModel(modelId)?.provider ?? "workers";
}

export function isReasoning(modelId: string): boolean {
  return findModel(modelId)?.reasoning === true;
}
