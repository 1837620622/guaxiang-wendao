import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { webSearch } from "../../src/websearch";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const DDG_HTML = `<div class="result"><h2><a class="result__a" href="https://example.com/ddg">财位怎么找</a></h2><a class="result__snippet">家里财位的找法</a></div>`;
const BING_HTML = `<ol><li class="b_algo"><h2><a href="https://example.com/bing">财位指南</a></h2><p>财位在哪里</p></li></ol>`;

test("一个源很慢时，其它源已经回来的结果照样返回", async () => {
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes("sogou.com")) {
      // 慢源：过了限时才回来。旧版整体 9 秒一刀切时，这里会把 ddg/bing 的结果也丢掉。
      await new Promise((r) => setTimeout(r, 1000));
      return new Response("", { status: 200 });
    }
    if (url.includes("duckduckgo.com")) return new Response(DDG_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.includes("bing.com")) return new Response(BING_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("", { status: 404 });
  }) as typeof fetch;

  const t0 = Date.now();
  const results = await webSearch("财位", 5, 200);
  const took = Date.now() - t0;

  assert.deepEqual(results.map((r) => r.source), ["duckduckgo", "bing"]);
  assert.ok(took < 900, `应在慢源之前返回，实际 ${took}ms`);
});

test("非 http(s) 的链接不会进入结果", async () => {
  globalThis.fetch = (async (input: any) => {
    if (String(input).includes("sogou.com")) {
      return new Response(
        `<h3 class="vr-title"><a href="javascript:alert(1)">财位 指南</a></h3>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  const results = await webSearch("财位", 5, 2000);
  assert.equal(results.length, 0);
});
