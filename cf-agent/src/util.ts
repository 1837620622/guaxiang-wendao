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
