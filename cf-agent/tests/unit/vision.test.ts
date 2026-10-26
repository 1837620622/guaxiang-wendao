import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeImage } from "../../src/vision";

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GOOD = "图中可见一张床靠墙，床头正对着一面镜子。";

test("模型正常返回时取到正文，并记下所用模型", async () => {
  const env = { AI: { run: async () => ({ response: GOOD }) } };
  const r = await analyzeImage(env, PNG_HEAD, "");
  assert.equal(r.ok, true);
  assert.equal(r.text, GOOD);
  assert.equal(r.model, "@cf/meta/llama-3.2-11b-vision-instruct");
});

test("主模型失败时换兜底模型", async () => {
  const env = {
    AI: {
      run: async (model: string) => {
        if (model.includes("llama")) throw new Error("upstream_down");
        return { response: GOOD };
      },
    },
  };
  const r = await analyzeImage(env, PNG_HEAD, "");
  assert.equal(r.ok, true);
  assert.equal(r.model, "@cf/llava-hf/llava-1.5-7b-hf");
});

test("两个模型都不回应时在时限内报 vision_timeout", async () => {
  const env = { AI: { run: () => new Promise<never>(() => {}) } };
  const t0 = Date.now();
  const r = await analyzeImage(env, PNG_HEAD, "", 20);
  assert.equal(r.ok, false);
  assert.equal(r.error, "vision_timeout");
  assert.ok(Date.now() - t0 < 2000, "超时应在两轮 20ms 内结束");
});
