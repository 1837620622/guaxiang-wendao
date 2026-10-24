import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLocation, resolveEnglishCity, findLocationInText } from "../../src/geo";

test("常见城市能解析，带行政区后缀也行", () => {
  assert.equal(resolveLocation("西安")?.name, "西安");
  assert.equal(resolveLocation("西安市")?.name, "西安");
  assert.equal(resolveLocation("我在西安雁塔区")?.name, "西安");
});

test("原型链上的属性名不能被当成城市（旧版会拿到函数并在解构时抛错）", () => {
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    assert.equal(resolveLocation(name), null, name);
  }
});

test("英文城市别名同样只认自有属性", () => {
  assert.equal(resolveEnglishCity("xi'an")?.name, "西安");
  assert.equal(resolveEnglishCity("constructor"), null);
});

test("从问题文本里找城市，取最长匹配", () => {
  assert.equal(findLocationInText("我家在西安，大门朝南")?.name, "西安");
  assert.equal(findLocationInText("没有城市名"), null);
});

test("真太阳时：北京为零，西安偏早约 44 分钟", () => {
  const bj = resolveLocation("北京");
  const xa = resolveLocation("西安");
  assert.ok(bj && xa);
  assert.equal(bj.lonOffsetMin, -14);
  assert.equal(xa.lonOffsetMin, -44);
});
