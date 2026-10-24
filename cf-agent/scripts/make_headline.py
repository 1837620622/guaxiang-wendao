#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把首页标题「卦象问道 / AI AGENT」渲染成像素 SVG 的 path 数据。

字形来自 GNU Unifont（16×16 点阵，汉字与 ASCII 同一套网格），
每个点画成一个矩形，同一行的连续点合并成一段。

用法：
  python3 scripts/make_headline.py [字体路径] > headline.txt

输出一段 <path d="..."/>，贴进 index.html 的标题 SVG 里即可。
版式：第一行汉字每点 436/64 个单位（撑满 .hero__title 宽度），
第二行 AI AGENT 每点减半，左对齐，整体 viewBox 为 0 0 436 174。
"""
import sys
from PIL import Image, ImageDraw, ImageFont

DEFAULT_FONT = "/usr/share/fonts/opentype/unifont/unifont.otf"
WIDTH = 436.0      # 与 .hero__title 的 u*436 对齐
CELL = 16          # 字形高度（点）
GAP = 10.0         # 两行之间的间距（单位）


def is_cjk(ch: str) -> bool:
    return ord(ch) > 0x2E80


def glyph_rows(font, text: str):
    """把整段文字排成一张 1-bit 位图，返回 (宽, 行列表)，行是 0/1 列表。"""
    cells = []
    for ch in text:
        w = CELL if is_cjk(ch) else CELL // 2
        im = Image.new("1", (w, CELL), 0)
        ImageDraw.Draw(im).text((0, 0), ch, font=font, fill=1)
        cells.append(im)
    total = sum(c.width for c in cells)
    canvas = Image.new("1", (total, CELL), 0)
    x = 0
    for c in cells:
        canvas.paste(c, (x, 0))
        x += c.width
    px = canvas.load()
    rows = [[1 if px[x, y] else 0 for x in range(canvas.width)] for y in range(CELL)]
    return canvas.width, rows


def rects(rows, x0: float, y0: float, dot: float) -> str:
    """每行的连续点合成一个矩形子路径。"""
    out = []
    for y, row in enumerate(rows):
        x = 0
        while x < len(row):
            if not row[x]:
                x += 1
                continue
            start = x
            while x < len(row) and row[x]:
                x += 1
            w = (x - start) * dot
            out.append(
                f"M{fmt(x0 + start * dot)} {fmt(y0 + y * dot)}h{fmt(w)}v{fmt(dot)}h{fmt(-w)}z"
            )
    return "".join(out)


def fmt(v: float) -> str:
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def main():
    font_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_FONT
    font = ImageFont.truetype(font_path, CELL)

    _, cjk_rows = glyph_rows(font, "卦象问道")
    _, latin_rows = glyph_rows(font, "AI AGENT")

    cjk_dot = WIDTH / 64.0          # 4 个汉字 × 16 点 = 64 点
    latin_dot = cjk_dot / 2.0       # 8 个字符 × 8 点 = 64 点，减半
    latin_y = CELL * cjk_dot + GAP

    d = rects(cjk_rows, 0, 0, cjk_dot) + rects(latin_rows, 0, latin_y, latin_dot)
    sys.stdout.write(d + "\n")


if __name__ == "__main__":
    main()
