#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓取完整性审计：章节数 / 空章 / 截断 / 乱码 / 重复 / 编号连续性"""
import os, re, sys, json, hashlib, collections

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOK = os.path.join(ROOT, "data", "chapters")
FULL = os.path.join(ROOT, "data", "改命记实录_全本.txt")

def main():
    files = sorted(f for f in os.listdir(BOOK) if f.endswith(".txt"))
    print(f"== 文件数: {len(files)}")

    rows = []
    problems = []
    hashes = collections.Counter()
    for i, f in enumerate(files, 1):
        p = os.path.join(BOOK, f)
        raw = open(p, encoding="utf-8").read()
        lines = [l for l in raw.split("\n") if l.strip()]
        title = lines[0] if lines else ""
        body = "\n".join(lines[1:])
        chars = len(body)
        rows.append({"idx": i, "file": f, "title": title, "chars": chars})
        if chars < 300:
            problems.append(("过短", f, chars))
        if re.search(r"本章还未完|点击下一页", body):
            problems.append(("截断", f, ""))
        if re.search(r"[\ufffd]{2,}", body):
            problems.append(("乱码", f, ""))
        if len(re.findall(r"[\u4e00-\u9fff]", body)) / max(chars, 1) < 0.35:
            problems.append(("中文字符占比过低", f, chars))
        h = hashlib.md5(body.encode()).hexdigest()
        hashes[h] += 1

    dup = [h for h, c in hashes.items() if c > 1]
    print(f"== 总字符: {sum(r['chars'] for r in rows)}")
    print(f"== 最短: {min(rows, key=lambda x: x['chars'])['chars']}  最长: {max(rows, key=lambda x: x['chars'])['chars']}")
    print(f"== 重复正文: {len(dup)} 组")
    print(f"== 问题: {len(problems)}")
    for x in problems[:30]:
        print("   ", x)

    # 编号连续性
    nums = []
    for r in rows:
        m = re.match(r"第(\d+)章", r["title"])
        if m:
            nums.append(int(m.group(1)))
        elif r["title"].startswith("番外"):
            nums.append(None)
    ints = [n for n in nums if n]
    missing = [i for i in range(1, 920) if i not in set(ints)]
    print(f"== 正文章节: {len(ints)}  范围 {min(ints)}-{max(ints)}")
    print(f"== 缺失编号: {missing}")
    print(f"== 番外: {sum(1 for n in nums if n is None)}")

    # 首尾抽检
    print("\n== 前 3 节 ==")
    for r in rows[:3]:
        print("  ", r["file"], "|", r["title"], "|", r["chars"])
    print("== 后 3 节 ==")
    for r in rows[-3:]:
        print("  ", r["file"], "|", r["title"], "|", r["chars"])

    if os.path.exists(FULL):
        print(f"\n== 全本: {os.path.getsize(FULL)} bytes")
    json.dump(rows, open(os.path.join(ROOT, "data", "audit.json"), "w"), ensure_ascii=False, indent=1)

if __name__ == "__main__":
    main()
