#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 data/chapters/*.txt 生成 chapters 表 SQL（原文阅读器用，保留完整正文）"""
import os, re, json

ROOT = os.path.dirname(os.path.abspath(__file__))          # cf-agent/scripts
BASE = os.path.dirname(os.path.dirname(ROOT))              # 卦象问道
BOOK = os.path.join(BASE, "data", "chapters")
OUT = os.path.join(ROOT, "..", "data")
OUT = os.path.abspath(OUT)
os.makedirs(OUT, exist_ok=True)

def main():
    files = sorted(f for f in os.listdir(BOOK) if f.endswith(".txt"))
    rows = []
    for order, f in enumerate(files, 1):
        raw = open(os.path.join(BOOK, f), encoding="utf-8").read()
        lines = [l.strip() for l in raw.split("\n") if l.strip()]
        if not lines:
            continue
        title = lines[0]
        body = "\n".join(lines[1:])
        m = re.match(r"^第(\d+)(?:章|篇|\s)", title)
        no = int(m.group(1)) if m else order
        rows.append((order, no, title, body))

    path = os.path.join(OUT, "chapters.sql")
    with open(path, "w", encoding="utf-8") as fp:
        fp.write("DROP TABLE IF EXISTS chapters;\n")
        fp.write("CREATE TABLE chapters(ord INTEGER PRIMARY KEY, no INTEGER, title TEXT, body TEXT);\n")
        fp.write("CREATE INDEX idx_chapters_no ON chapters(no);\n")
        buf = []
        for order, no, title, body in rows:
            t = title.replace("'", "''")
            b = body.replace("'", "''")
            buf.append(f"({order},{no},'{t}','{b}')")
            if len(buf) >= 12:
                fp.write("INSERT INTO chapters(ord,no,title,body) VALUES\n" + ",\n".join(buf) + ";\n")
                buf = []
        if buf:
            fp.write("INSERT INTO chapters(ord,no,title,body) VALUES\n" + ",\n".join(buf) + ";\n")

    size = os.path.getsize(path)
    print(f"chapters: {len(rows)}  sql: {path}  {size} bytes")
    json.dump({"chapters": len(rows), "sql_bytes": size},
              open(os.path.join(ROOT, "..", "data", "chapters_stats.json"), "w"),
              ensure_ascii=False, indent=2)

if __name__ == "__main__":
    main()
