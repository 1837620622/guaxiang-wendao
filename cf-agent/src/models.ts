/** Workers AI 上可用于中文问答的文本模型（已逐个实测） */
export interface ModelInfo {
  id: string;
  label: string;
  note: string;
  group: "推荐" | "中文强" | "快速" | "推理型";
  /** 是否为思考链模型（需要更大 token 预算） */
  reasoning?: boolean;
}

/**
 * 实测数据（2026-10-23，REST 直连，8 token 测试提示）
 * 延迟是"模型本身"的量级，实际问答还要加 prompt 处理时间。
 */
export const MODELS: ModelInfo[] = [
  // —— 默认与首选 ——
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 70B", note: "最快最稳 · 默认", group: "推荐" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", label: "Mistral Small 3.1", note: "极快 · 约 3s", group: "推荐" },
  { id: "@cf/deepseek-ai/deepseek-v4-flash-0731", label: "DeepSeek V4 Flash", note: "中文强 · 约 4s", group: "推荐" },
  { id: "@cf/deepseek-ai/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash", note: "中文强 · 约 4s", group: "推荐" },

  // —— 中文强 ——
  { id: "@cf/qwen/qwen3.8-27b", label: "Qwen 3.8 27B", note: "中文强 · 约 3s", group: "中文强" },
  { id: "@cf/moonshotai/kimi-k2.6", label: "Kimi K2.6", note: "长文强 · 约 4s", group: "中文强" },
  { id: "@cf/zai-org/glm-4.7-flash", label: "GLM-4.7 Flash", note: "中文好 · 约 9s", group: "中文强" },
  { id: "@cf/deepseek-ai/deepseek-v4-pro-0813", label: "DeepSeek V4 Pro", note: "更强 · 约 3s", group: "中文强" },
  { id: "@cf/zai-org/glm-5.3-flash", label: "GLM-5.3 Flash", note: "中文好 · 约 10s", group: "中文强" },

  // —— 快速轻量 ——
  { id: "@cf/meta/llama-4-scout-17b-16e-instruct", label: "Llama 4 Scout", note: "轻量 · 约 2s", group: "快速" },
  { id: "@cf/openai/gpt-oss-20b", label: "GPT-OSS 20B", note: "轻量 · 约 3s", group: "快速" },
  { id: "@cf/nvidia/nemotron-3-120b-a12b", label: "Nemotron 3 120B", note: "约 2s", group: "快速" },

  // —— 推理型（会先思考，慢，但结论更细）——
  { id: "@cf/qwen/qwen3-30b-a3b-fp8", label: "Qwen3 30B A3B", note: "推理型 · 约 5s", group: "推理型", reasoning: true },
  { id: "@cf/openai/gpt-oss-120b", label: "GPT-OSS 120B", note: "推理型 · 约 5s", group: "推理型", reasoning: true },
  { id: "@cf/zai-org/glm-5.3", label: "GLM-5.3", note: "推理型 · 约 5s", group: "推理型", reasoning: true },
  { id: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B", note: "推理型 · 约 14s", group: "推理型", reasoning: true },
];

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** 兜底优先顺序（快而稳） */
export const FALLBACK_CHAIN = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/deepseek-ai/deepseek-v4-flash-0731",
];

export function isReasoning(modelId: string): boolean {
  return MODELS.find((m) => m.id === modelId)?.reasoning === true;
}
