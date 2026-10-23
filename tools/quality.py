#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""原文深度质量诊断：乱码 / 残缺 / 分页残留 / 重复 / 断句"""
import os, re, json, collections, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOK = os.path.join(ROOT, "data", "chapters")

PATTERNS = {
    "分页残留": re.compile(r"\(\d+/\d+\)|（\d+/\d+）"),
    "未完标记": re.compile(r"本章还未完|点击下一页|请记住本书|百度搜索|笔趣阁"),
    "替换符": re.compile(r"\ufffd"),
    "经典乱码": re.compile(r"锟斤拷|烫烫烫|屯屯屯|鍙|鈥|銆|锛|鐨|鍜|涓|鏄"),
    "HTML残留": re.compile(r"<[a-zA-Z/][^>]{0,40}>|&[a-z]{2,6};"),
    "重复标点": re.compile(r"[，。！？]{4,}"),
    "空行密集": re.compile(r"\n{4,}"),
}

def main():
    files = sorted(f for f in os.listdir(BOOK) if f.endswith(".txt"))
    rows = []
    issues = collections.defaultdict(list)
    hashes = {}

    for i, f in enumerate(files, 1):
        raw = open(os.path.join(BOOK, f), encoding="utf-8").read()
        lines = [l.strip() for l in raw.split("\n") if l.strip()]
        title = lines[0] if lines else ""
        body = "\n".join(lines[1:])
        chars = len(body)
        han = len(re.findall(r"[\u4e00-\u9fff]", body))
        ratio = han / max(chars, 1)

        rows.append({"idx": i, "file": f, "title": title, "chars": chars, "han": han, "ratio": round(ratio, 3)})

        for name, pat in PATTERNS.items():
            hits = pat.findall(body)
            if hits:
                issues[name].append((f, len(hits), str(hits[:3])[:80]))

        # 结尾是否像断句（没有句末标点）
        if body and body[-1] not in "。！？…\"”』」）)":
            issues["结尾非句末"].append((f, 1, body[-30:]))

        # 开头是否异常（数字/英文/短句）
        if body and len(body) > 50:
            head = body[:20]
            if re.match(r"^[\d\W]+$", head):
                issues["开头异常"].append((f, 1, head))

        h = hashlib.md5(body.encode()).hexdigest()
        if h in hashes:
            issues["重复正文"].append((f, 1, f"= {hashes[h]}"))
        else:
            hashes[h] = f

    chars = [r["chars"] for r in rows]
    chars_sorted = sorted(chars)
    med = chars_sorted[len(chars_sorted) // 2]
    print(f"章节数: {len(rows)}")
    print(f"总字符: {sum(chars)}")
    print(f"字数: 最短 {min(chars)}  中位 {med}  最长 {max(chars)}")
    print(f"汉字占比: 最低 {min(r['ratio'] for r in rows):.3f}  平均 {sum(r['ratio'] for r in rows)/len(rows):.3f}")

    print("\n=== 异常短章（< 中位数 40%）===")
    short = [r for r in rows if r["chars"] < med * 0.4]
    for r in short[:25]:
        print(f"  {r['file']}  {r['chars']}字")
    print(f"  共 {len(short)} 章")

    print("\n=== 问题分类 ===")
    for name, lst in issues.items():
        print(f"\n[{name}] {len(lst)} 处")
        for x in lst[:8]:
            print("   ", x[0], x[1], x[2])

    json.dump({"rows": rows, "issues": {k: v[:50] for k, v in issues.items()}},
              open(os.path.join(ROOT, "data", "quality.json"), "w"),
              ensure_ascii=False, indent=1)
    print("\n已写入 data/quality.json")

if __name__ == "__main__":
    main()
