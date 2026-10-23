/**
 * 图片理解：家居照片 / 户型图 / 罗盘照片
 * 主模型 llama-3.2-11b-vision，兜底 llava-1.5-7b
 */

export interface VisionResult {
  ok: boolean;
  text: string;
  model: string;
  ms: number;
  error?: string;
}

const VISION_MODELS = [
  "@cf/meta/llama-3.2-11b-vision-instruct",
  "@cf/llava-hf/llava-1.5-7b-hf",
];

/** 允许的图片类型 */
export const OK_MIME = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/bmp", "image/gif",
]);

export const MAX_BYTES = 4 * 1024 * 1024; // 4MB

/** 只认 JPEG / PNG / WebP 文件头，不信 MIME 声明。 */
export function imageKind(bytes: Uint8Array): "jpeg" | "png" | "webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "webp";
  return null;
}

/** 从 dataURL 或纯 base64 里取出字节 */
export function base64ToBytes(input: string): Uint8Array | null {
  let s = input.trim();
  const m = s.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (m) {
    if (m[1] && !OK_MIME.has(m[1].toLowerCase())) return null;
    s = m[3];
  }
  s = s.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 判断是不是户型图/平面图，决定提示词 */
function looksLikeFloorPlan(hint: string): boolean {
  return /户型|平面|布局|结构|floor|平面图|格局/.test(hint);
}

/**
 * 图像 → 风水相关描述
 * 输出结构化的中文摘要，供 RAG 阶段使用
 */
export async function analyzeImage(
  env: any,
  bytes: Uint8Array,
  userHint = ""
): Promise<VisionResult> {
  const t0 = Date.now();

  const planMode = looksLikeFloorPlan(userHint);
  const prompt = planMode
    ? `这是一张房屋平面图/户型图。请只描述你能从图上确定看到的内容，不要猜测。
输出格式（纯文本，不要 Markdown）：
1. 房间：逐个列出图中标注的房间名称（例如：客厅、主卧、厨房、卫生间、阳台）
2. 相对位置：每个房间在图的上下左右哪个位置（例如：厨房在左上，卫生间在右下）
3. 大门：如果能看到门的位置，说明在哪一侧
4. 明显物件：灶台、床、马桶、鱼缸、镜子、横梁等，标出所在房间
5. 方位标注：图上有没有指北针或东南西北字样？有就说明方向，没有就写"无方位标注"
6. 不确定：列出你判断不了的部分
不要给风水建议，只描述图面事实。`
    : `这是一张室内/房屋/风水相关照片。请只描述你能确定看到的内容，不要猜测。
输出格式（纯文本，不要 Markdown）：
1. 场景：这是什么空间（客厅/卧室/厨房/卫生间/门口/院子/其他）
2. 主要物件：逐个列出看到的家具、电器、摆件
3. 位置关系：物件之间、物件与门窗的相对位置
4. 明显问题：如果看到镜子对床、横梁压顶、门对门、尖角对着座位、灶台对水槽这一类格局，指出来
5. 不确定：列出你判断不了的部分
不要给风水建议，只描述图面事实。`;

  let lastErr = "";
  for (const model of VISION_MODELS) {
    try {
      const out: any = await Promise.race([
        env.AI.run(model, {
          image: Array.from(bytes),
          prompt,
          max_tokens: 700,
          temperature: 0.2,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("vision_timeout")), 45000)),
      ]);
      const text =
        out?.response ??
        out?.result?.response ??
        out?.description ??
        (typeof out === "string" ? out : "");
      if (text && String(text).trim().length > 10) {
        return { ok: true, text: String(text).trim(), model, ms: Date.now() - t0 };
      }
      lastErr = "empty response";
    } catch (e: any) {
      lastErr = String(e?.message ?? e);
    }
  }
  return { ok: false, text: "", model: "", ms: Date.now() - t0, error: lastErr === "vision_timeout" ? "vision_timeout" : "vision_failed" };
}

/** 图片分析结果 → 提示词块 */
export function visionPromptBlock(v: VisionResult): string {
  if (!v.ok) return "";
  return `【图片分析（由视觉模型从用户上传的图片中读出的事实，仅供定位问题，不是风水结论）】
${v.text}`;
}
