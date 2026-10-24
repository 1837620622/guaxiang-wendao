import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../../src/index";
import { runExternal } from "../../src/llm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

test("页面不再允许外部媒体（立绘是内联 SVG）", async () => {
  const res = await worker.fetch(req("/"), env());
  const csp = res.headers.get("Content-Security-Policy") || "";
  assert.match(csp, /media-src 'none'/);
  assert.doesNotMatch(csp, /cloudfront/);
});

test("脚本只放行同源文件，不允许内联脚本", async () => {
  const res = await worker.fetch(req("/"), env());
  const csp = res.headers.get("Content-Security-Policy") || "";
  const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
  assert.equal(scriptSrc, "script-src 'self'");
});

test("页面标记里没有内联脚本和内联事件属性，否则会被 CSP 拦下", () => {
  for (const file of ["public/index.html", "public/read.html"]) {
    const html = readFileSync(resolve(file), "utf8");
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i, file);
    const markup = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    assert.doesNotMatch(markup, /<[a-z][^>]*\son[a-z]+\s*=/i, file);
  }
});

/** KV 桩：每个键都返回一个很大的计数，相当于当天已经超限 */
const fullKv = {
  get: async () => "999",
  put: async () => undefined,
};
/** 限流绑定桩：success 为 false 时相当于本分钟已经超限 */
const limiter = (success: boolean) => ({ limit: async () => ({ success }) });
const askPost = () =>
  req("/api/ask", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: "{}" });

test("每分钟超限返回 429，并带 Retry-After 头和正文里的 retryAfter", async () => {
  const res = await worker.fetch(askPost(), env({ CACHE: fullKv, RL_ASK: limiter(false) }));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "60");
  const data = (await res.json()) as any;
  assert.equal(data.error, "too_many_requests_per_minute");
  assert.equal(data.retryAfter, 60);
});

test("每分钟没超、当天已超，返回 too_many_requests_per_day", async () => {
  const res = await worker.fetch(askPost(), env({ CACHE: fullKv, RL_ASK: limiter(true) }));
  assert.equal(res.status, 429);
  assert.equal(((await res.json()) as any).error, "too_many_requests_per_day");
});

test("限流绑定出错时按失败关闭，不放行", async () => {
  const broken = { limit: async () => { throw new Error("binding down"); } };
  const res = await worker.fetch(askPost(), env({ CACHE: fullKv, RL_ASK: broken }));
  assert.equal(res.status, 429);
  assert.equal(((await res.json()) as any).error, "rate_limit_unavailable");
});

test("两道限额都没超才放行，并把当天计数加一（空问题在限流之后才校验）", async () => {
  const puts: string[] = [];
  const kv = {
    get: async () => "3",
    put: async (_key: string, value: string) => { puts.push(value); },
  };
  const res = await worker.fetch(askPost(), env({ CACHE: kv, RL_ASK: limiter(true) }));
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as any).error, "question_required");
  assert.deepEqual(puts, ["4"]);
});

test("每个响应都带 X-Request-Id；合法的上游编号原样沿用", async () => {
  const res = await worker.fetch(req("/api/geo?q=toString", { headers: { "X-Request-Id": "abc-12345678" } }), env());
  assert.equal(res.headers.get("X-Request-Id"), "abc-12345678");
});

test("上游编号不合法时自己生成，仍然带头", async () => {
  const res = await worker.fetch(req("/api/geo?q=toString", { headers: { "X-Request-Id": "bad id!!" } }), env());
  const rid = res.headers.get("X-Request-Id") || "";
  assert.match(rid, /^[0-9a-f-]{36}$/);
});

test("模型清单允许缓存十分钟", async () => {
  const res = await worker.fetch(req("/api/models"), env());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=600");
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
