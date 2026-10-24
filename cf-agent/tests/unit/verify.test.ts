import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyQuote, pointTouchesSource, scrubFakeChapter, extractJSON, searchText, cleanText } from "../../src/verify";

const BOOK = "床头不要对着门，床尾也不宜冲窗。\n厨房灶台不要正对卫生间的门，水火相冲。\n镜子不宜正对床头。";

test("引文逐字命中才算核对", () => {
  assert.equal(verifyQuote("床头不要对着门，床尾也不宜冲窗。", BOOK), true);
  // 标点、空白不同不影响判断
  assert.equal(verifyQuote("床头不要对着门 床尾也不宜冲窗", BOOK), true);
});

test("省略号分段：每段都要按顺序出现", () => {
  assert.equal(verifyQuote("床头不要对着门……镜子不宜正对床头", BOOK), true);
  assert.equal(verifyQuote("镜子不宜正对床头……床头不要对着门", BOOK), false, "顺序颠倒");
});

test("首尾真实、中间编造的引文不能通过（旧版首尾 12 字匹配会放行）", () => {
  const fake = "床头不要对着门，阴阳失调必有大祸，镜子不宜正对床头。";
  assert.equal(verifyQuote(fake, BOOK), false);
});

test("太短的引文不算核对", () => {
  assert.equal(verifyQuote("床头", BOOK), false);
});

test("书中做法：只共享四个字不算出处", () => {
  // 「这个位置」在原文里有，但只有四个字，不能证明这句是书里的做法
  assert.equal(pointTouchesSource("这个位置要见光、能换气", "书里讲到这个位置的采光。"), false);
});

test("书中做法：共享六个连续汉字才算出处，标点不打断", () => {
  assert.equal(pointTouchesSource("床头不要对着门，要注意", BOOK), true);
  assert.equal(pointTouchesSource("床头，不要对着门", BOOK), true, "标点不打断连续汉字");
  // 一个字都不挨着的说法，不能靠零散的词蹭上出处
  assert.equal(pointTouchesSource("门口挂风铃，招来好运气", BOOK), false);
});

test("日常段里不存在的章号会被删掉", () => {
  const chapters = new Set([3, 12]);
  assert.equal(scrubFakeChapter("见第3章的说法，别信第999章。", chapters), "见第3章的说法，别信。");
});

test("extractJSON 从前后有废话的输出里取出含 verdict 的对象", () => {
  const text = "好的，结果如下：\n```json\n{\"verdict\": \"部分依据\", \"points\": []}\n```";
  assert.deepEqual(extractJSON(text), { verdict: "部分依据", points: [] });
  assert.equal(extractJSON("没有 JSON"), null);
});

test("英文提问的方位词按整词匹配，southeast 不会被拆成正东", () => {
  const out = searchText("southeast corner", "en");
  assert.match(out, /巽 东南/);
  assert.doesNotMatch(out, /震 东/);
});

test("cleanText 去掉危险协议并限长", () => {
  assert.equal(cleanText("javascript:alert(1) 好", 100), "alert(1) 好");
  assert.equal(cleanText("abcdef", 3), "abc");
});
