import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../../src/index";
import { runExternal } from "../../src/llm";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const ORIGIN = "https://chuankangkk.top";

const ROWS = [
  { ord: 1, no: 1, title: "第1章 开篇", body: "开篇的正文。" },
  { ord: 5, no: 5, title: "第5章 厨房", body: "灶台与水的关系。" },
];

/** 只实现 handleChapter 用到的几条 SQL，按 WHERE 子句分派 */
const fakeDb = {
  prepare(sql: string) {
    return {
      bind(...args: unknown[]) {
        const v = args[0] as number;
        return {
          first: async () => {
            if (sql.includes("WHERE no = ?")) return ROWS.find((r) => r.no === v) ?? null;
            if (sql.includes("WHERE ord = ?")) return ROWS.find((r) => r.ord === v) ?? null;
            if (sql.includes("ord < ?")) return ROWS.filter((r) => r.ord < v).pop() ?? null;
            if (sql.includes("ord > ?")) return ROWS.find((r) => r.ord > v) ?? null;
            return null;
          },
        };
      },
    };
  },
};

const env = (extra: Record<string, unknown> = {}) =>
  ({
    DB: fakeDb,
    ASSETS: { fetch: async () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }) },
    ...extra,
  }) as any;

const req = (path: string, init?: RequestInit) => new Request(ORIGIN + path, init);

test("写接口拒绝非 JSON 的请求体（跨站表单发不出 application/json）", async () => {
  const res = await worker.fetch(req("/api/ask", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }), env());
  assert.equal(res.status, 415);
});

test("写接口拒绝来自别的站点的 Origin", async () => {
  const res = await worker.fetch(
    req("/api/ask", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" }),
    env()
  );
  assert.equal(res.status, 403);
});

test("同源 JSON 请求通过守卫（这里没有 KV，限流按失败关闭返回 429）", async () => {
  const res = await worker.fetch(
    req("/api/ask", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: "{}" }),
    env()
  );
  assert.equal(res.status, 429);
});

test("?no=&ord=5 应按 ord 查，不能查成 ord=0", async () => {
  const res = await worker.fetch(req("/api/chapter?no=&ord=5"), env());
  assert.equal(res.status, 200);
  const data = (await res.json()) as any;
  assert.equal(data.ord, 5);
  assert.equal(data.title, "第5章 厨房");
});

test("章号必须是正整数", async () => {
  const res = await worker.fetch(req("/api/chapter?no=1.5"), env());
  assert.equal(res.status, 400);
});

test("地理接口遇到原型链上的名字返回 404，不是 500", async () => {
  const res = await worker.fetch(req("/api/geo?q=toString"), env());
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as any).error, "city_not_found");
});

test("静态页面带上安全头", async () => {
  const res = await worker.fetch(req("/"), env());
  assert.match(res.headers.get("Content-Security-Policy") || "", /frame-ancestors 'self'/);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
});

test("模型请求过了截止时间就不再换钥匙、不再发请求", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: 429 });
  }) as typeof fetch;
  await assert.rejects(
    runExternal({ GROQ_API_KEYS: "k1,k2,k3" } as any, "openai/gpt-oss-20b", "s", "u", 100, 10000, false, Date.now() - 1),
    /upstream_fail/
  );
  assert.equal(calls, 0);
});

test("模型请求没超时时，每把钥匙都会轮到，最后报出最后一次的状态", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: 429 });
  }) as typeof fetch;
  await assert.rejects(
    runExternal({ GROQ_API_KEYS: "k1,k2,k3" } as any, "openai/gpt-oss-20b", "s", "u", 100, 10000, false),
    /upstream_429/
  );
  assert.equal(calls, 3);
});
