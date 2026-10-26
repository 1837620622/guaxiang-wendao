import { test } from "node:test";
import assert from "node:assert/strict";
import { toNumberParam } from "../../src/util";

test("缺省、null、空串与空白都得到 NaN，不能当成 0", () => {
  assert.ok(Number.isNaN(toNumberParam(undefined)));
  assert.ok(Number.isNaN(toNumberParam(null)));
  assert.ok(Number.isNaN(toNumberParam("")));
  assert.ok(Number.isNaN(toNumberParam("   ")));
});

test("数字与数字字符串照常转换，非数字得到 NaN", () => {
  assert.equal(toNumberParam(0), 0);
  assert.equal(toNumberParam(6), 6);
  assert.equal(toNumberParam("6"), 6);
  assert.equal(toNumberParam(" 12 "), 12);
  assert.ok(Number.isNaN(toNumberParam("abc")));
  assert.ok(Number.isNaN(toNumberParam({})));
});
