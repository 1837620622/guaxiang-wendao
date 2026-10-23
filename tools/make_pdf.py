#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 book/*.txt 合成带目录、页码的 PDF（weasyprint）"""
import os, re, html, subprocess, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOOK = os.path.join(ROOT, "data", "chapters")
outdir = os.path.join(ROOT, "output"); os.makedirs(outdir, exist_ok=True)
OUT_HTML = os.path.join(outdir, "改命记实录.html")
OUT_PDF = os.path.join(outdir, "改命记实录.pdf")

def main():
    files = sorted(f for f in os.listdir(BOOK) if f.endswith(".txt"))
    print("chapters:", len(files))

    toc, sections = [], []
    for i, f in enumerate(files, 1):
        raw = open(os.path.join(BOOK, f), encoding="utf-8").read()
        lines = [l.strip() for l in raw.split("\n")]
        title = lines[0] if lines else f
        body = [l for l in lines[1:] if l]
        # 段落化
        paras = "".join(f"<p>{html.escape(p)}</p>" for p in body)
        cid = f"ch{i:04d}"
        toc.append(f'<li><a href="#{cid}">{html.escape(title)}</a></li>')
        sections.append(
            f'<section class="ch" id="{cid}"><h2>{html.escape(title)}</h2>{paras}</section>'
        )

    today = datetime.date.today().isoformat()
    doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>改命记实录</title>
<style>
@page {{
  size: A5;
  margin: 18mm 15mm 20mm 15mm;
  @bottom-center {{
    content: counter(page);
    font-family: "Songti SC", serif;
    font-size: 9pt;
    color: #777;
  }}
  @top-center {{
    content: "改命记实录 · 道之光";
    font-family: "Songti SC", serif;
    font-size: 8pt;
    color: #aaa;
  }}
}}
@page cover {{ margin: 0; @bottom-center {{ content: none; }} @top-center {{ content: none; }} }}
@page toc {{ @top-center {{ content: "目录"; }} }}

html {{ font-family: "Songti SC","STSong","Noto Serif SC",serif; }}
body {{ margin: 0; color: #222; font-size: 10.5pt; line-height: 1.75; }}

.cover {{
  page: cover; height: 100vh; display: flex; flex-direction: column;
  justify-content: center; align-items: center; text-align: center;
  background: #f7f2e7;
}}
.cover .seal {{
  width: 64px; height: 64px; border-radius: 12px; background: #a83b2c; color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 34px; font-weight: bold; margin-bottom: 26px;
}}
.cover h1 {{ font-size: 30pt; letter-spacing: .18em; margin: 0 0 10px; }}
.cover .au {{ font-size: 13pt; color: #6b6355; letter-spacing: .1em; }}
.cover .meta {{ position: absolute; bottom: 26mm; font-size: 9pt; color: #8d8575; }}

.toc {{ page: toc; }}
.toc h1 {{ font-size: 18pt; text-align: center; margin: 0 0 16px; letter-spacing: .3em; }}
.toc ol {{ list-style: none; padding: 0; margin: 0; column-count: 1; }}
.toc li {{ font-size: 9pt; line-height: 1.55; border-bottom: 1px dotted #ddd; }}
.toc li a {{ color: #333; text-decoration: none; display: block; padding: 1.5px 0; }}
.toc li a::after {{ content: target-counter(attr(href), page); float: right; color: #999; }}

.ch {{ break-before: page; }}
.ch h2 {{
  font-size: 14pt; margin: 0 0 12px; padding-bottom: 6px;
  border-bottom: 1px solid #ddd; letter-spacing: .06em;
}}
.ch p {{ margin: 0 0 .55em; text-indent: 2em; text-align: justify; }}
</style></head>
<body>
<div class="cover">
  <div class="seal">卦</div>
  <h1>改命记实录</h1>
  <div class="au">道之光 著</div>
  <div class="meta">共 {len(files)} 节 · 抓取整理 {today}</div>
</div>
<div class="toc">
  <h1>目 录</h1>
  <ol>{''.join(toc)}</ol>
</div>
{''.join(sections)}
</body></html>"""

    open(OUT_HTML, "w", encoding="utf-8").write(doc)
    print("html:", OUT_HTML, os.path.getsize(OUT_HTML))
    cmd = ["weasyprint", OUT_HTML, OUT_PDF]
    print("running:", " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    print("exit", r.returncode)
    if r.stderr:
        print(r.stderr[-2000:])
    if os.path.exists(OUT_PDF):
        print("pdf:", OUT_PDF, os.path.getsize(OUT_PDF))

if __name__ == "__main__":
    main()
