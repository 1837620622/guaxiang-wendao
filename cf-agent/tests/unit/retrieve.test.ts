import { test } from "node:test";
import assert from "node:assert/strict";
import { extractKeywords } from "../../src/retrieve";

test("财位问法保留原词，不切两字碎片，不扩到九宫", () => {
  const ks = extractKeywords("家里的财位怎么找");
  assert.ok(ks.includes("财位"));
  assert.equal(ks.includes("里的"), false);
  assert.equal(ks.includes("位怎"), false);
  assert.equal(ks.includes("九宫"), false);
  assert.equal(ks.includes("财"), false);
});

test("朝向按原词检索，不扩成九宫或宫位", () => {
  const ks = extractKeywords("房子朝向怎么看");
  assert.ok(ks.includes("朝向"));
  assert.equal(ks.includes("九宫"), false);
  assert.equal(ks.includes("宫位"), false);
});

test("东南和床按书里的说法检索", () => {
  const ks = extractKeywords("东南角的床怎么放");
  assert.ok(ks.includes("东南"));
  assert.ok(ks.includes("床头"));
  assert.equal(ks.includes("九宫"), false);
  assert.equal(ks.includes("角的"), false);
  assert.equal(ks.includes("床"), false);
});

test("没有原词时，不把的、了、怎么切进检索词", () => {
  const ks = extractKeywords("家里的窗台怎么放");
  assert.ok(ks.includes("窗台"));
  assert.equal(ks.includes("里的"), false);
  assert.equal(ks.includes("的窗"), false);
  assert.equal(ks.includes("怎么"), false);
  assert.equal(ks.includes("台怎"), false);
});
