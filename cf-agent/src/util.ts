/**
 * 限时。超时就以 code 拒绝；无论谁先完成，定时器都会清掉，不留到下一次请求。
 */
export function withTimeout<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), Math.max(0, ms));
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/**
 * 请求参数转数字。缺省、null、空串与空白一律得到 NaN；不能直接用 Number()，
 * 因为 Number(null) 与 Number("") 都是 0，会把「没传」变成一个真实的取值。
 */
export function toNumberParam(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}
