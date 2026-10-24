#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
首页「卦先生」像素立绘（Q 版）。

每一行用「字符 × 个数」描述，从左到右：
  c 道冠（实心）                 r 道袍（实心）
  m 眉、腮红、嘴（实心小笔画）     f 脸（只画外轮廓，里面透出底色）
  h 眼睛上的高光（透出底色）       e 眼睛（单独一层，眨眼时隐去）
  b 胡须（只画外轮廓，单独一层，会轻轻摆动）
  l 罗盘（单独一层，会轻微起伏）   t 符纸（三张，单独成组，会漂浮）
  . 透出底色

格子单位：立绘 48×52 格。页面里用 transform 放大到 1920×1080 的舞台上，
每格 14 个舞台单位。头占上半身，身子短，眼睛和嘴是主要的脸部信息。

用法：
  python3 scripts/make_master.py              打印 ASCII 预览
  python3 scripts/make_master.py --write      写进 public/index.html 和 public/app.js 的标记之间
  python3 scripts/make_master.py --png out.png  输出 PNG 预览（需要 Pillow）
"""
import random
import re
import sys
from pathlib import Path

W, H = 48, 52
FRAME_W, FRAME_H = 1920, 1080   # 舞台坐标（与 viewBox 一致）
FIG_X, FIG_Y, CELL = 1000, 200, 14   # 立绘左上角与每格大小（舞台单位）
ANCHOR_CELL = (25.5, 3.0)       # 气泡尾巴指向的格子：道冠顶部偏右

# 每行从左到右的段：(字符, 格数)。每行合计必须是 W。
ROWS = [
    [(".", 18), ("c", 12), (".", 18)],                                  # 0 道冠
    [(".", 16), ("c", 16), (".", 16)],                                  # 1
    [(".", 15), ("c", 18), (".", 15)],                                  # 2
    [(".", 14), ("c", 20), (".", 14)],                                  # 3
    [(".", 12), ("c", 24), (".", 12)],                                  # 4
    [(".", 10), ("c", 28), (".", 10)],                                  # 5 帽檐
    [(".", 15), ("f", 18), (".", 15)],                                  # 6 脸顶
    [(".", 13), ("f", 22), (".", 13)],                                  # 7
    [(".", 12), ("f", 24), (".", 12)],                                  # 8
    [(".", 12), ("f", 24), (".", 12)],                                  # 9
    [(".", 12), ("f", 4), ("m", 3), ("f", 10), ("m", 3), ("f", 4), (".", 12)],   # 10 眉
    [(".", 12), ("f", 24), (".", 12)],                                  # 11
    [(".", 12), ("f", 24), (".", 12)],                                  # 12
    [(".", 12), ("f", 4), ("e", 1), ("h", 1), ("f", 12), ("h", 1), ("e", 1), ("f", 4), (".", 12)],  # 13 眼顶
    [(".", 12), ("f", 4), ("e", 2), ("f", 12), ("e", 2), ("f", 4), (".", 12)],  # 14 眼
    [(".", 12), ("f", 4), ("e", 2), ("f", 12), ("e", 2), ("f", 4), (".", 12)],  # 15 眼
    [(".", 12), ("f", 2), ("m", 2), ("f", 16), ("m", 2), ("f", 2), (".", 12)],  # 16 腮红
    [(".", 12), ("f", 10), ("m", 1), ("f", 2), ("m", 1), ("f", 10), (".", 12)],  # 17 嘴角
    [(".", 12), ("f", 11), ("m", 2), ("f", 11), (".", 12)],                     # 18 嘴
    [(".", 12), ("f", 24), (".", 12)],                                  # 19 下巴
    [(".", 13), ("f", 22), (".", 13)],                                  # 20
    [(".", 15), ("f", 4), ("b", 10), ("f", 4), (".", 15)],              # 21 胡须起
    [(".", 18), ("f", 1), ("b", 10), ("f", 1), (".", 18)],              # 22
    [(".", 19), ("b", 10), (".", 19)],                                  # 23
    [(".", 20), ("b", 8), (".", 20)],                                   # 24
    [(".", 17), ("r", 4), ("b", 6), ("r", 4), (".", 17)],               # 25 肩
    [(".", 15), ("r", 7), ("b", 4), ("r", 7), (".", 15)],               # 26
    [(".", 13), ("r", 10), ("b", 2), ("r", 10), (".", 13)],             # 27
    [(".", 11), ("r", 26), (".", 11)],                                  # 28
    [(".", 10), ("r", 1), (".", 1), ("r", 24), (".", 1), ("r", 1), (".", 10)],  # 29 袖口缝
    [(".", 9), ("r", 2), (".", 1), ("r", 24), (".", 1), ("r", 2), (".", 9)],    # 30
] + [
    [(".", 8), ("r", 3), (".", 1), ("r", 24), (".", 1), ("r", 3), (".", 8)]     # 31-37 袖子
    for _ in range(31, 38)
] + [
    [(".", 48)],                                                        # 38 腰带透缝
] + [
    [(".", 7), ("r", 34), (".", 7)] for _ in range(39, 45)              # 39-44 道袍
] + [
    [(".", 6), ("r", 36), (".", 6)] for _ in range(45, 52)              # 45-51 下摆
]
assert len(ROWS) == H, len(ROWS)

LID_CELLS = [(16, 14), (17, 14), (30, 14), (31, 14)]   # 眨眼时才显示的眼皮（闭眼线）

LUO_C = (14, 44)                           # 罗盘圆心（格子坐标）
LUO_R2 = 4.8 * 4.8                         # 外半径²
LUO_HALO2 = 6.3 * 6.3                      # 罗盘周围让出的空隙

TAL_SHAPE = [
    "#####",
    "#...#",
    "#.#.#",
    "#...#",
    "#.#.#",
    "#...#",
    "#...#",
    "#####",
]
TALS = [(39, 6), (41, 17), (41, 30)]       # 三张符纸左上角（格子坐标，都在身体之外）

FACE_LETTERS = "fhem"                      # 脸的区域：外轮廓由它们的边界决定
BODY_LETTERS = "crm"                       # 实心的部分（道冠、道袍、眉嘴腮红）


def line_cells(x0, y0, x1, y1):
    """两点之间的整数格子（沿较长的那一轴取样）。"""
    n = max(abs(x1 - x0), abs(y1 - y0))
    return [(round(x0 + (x1 - x0) * i / n), round(y0 + (y1 - y0) * i / n)) for i in range(n + 1)]


def outline(cells, region):
    """区域里有一个邻格不在区域内的格子，才算外轮廓。"""
    out = []
    for x, y in cells:
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if (nx, ny) not in region:
                out.append((x, y))
                break
    return out


def build():
    grid = [["."] * W for _ in range(H)]
    for y, segs in enumerate(ROWS):
        x = 0
        for ch, n in segs:
            for _ in range(n):
                grid[y][x] = ch
                x += 1
        assert x == W, f"row {y} has {x} cells"

    # 罗盘：外圈以内实心，外圈与画面其余部分之间留一圈空隙；中间一道环线透出底色
    cx, cy = LUO_C
    for y in range(H):
        for x in range(W):
            d2 = (x - cx) ** 2 + (y - cy) ** 2
            if LUO_R2 < d2 <= LUO_HALO2:
                grid[y][x] = "."
            elif d2 <= LUO_R2:
                grid[y][x] = "." if 9 <= d2 <= 11 else "l"

    face = [(x, y) for y in range(H) for x in range(W) if grid[y][x] in FACE_LETTERS]
    beard = [(x, y) for y in range(H) for x in range(W) if grid[y][x] == "b"]
    face_set, beard_set = set(face), set(beard)

    layers = {"body": [], "beard": [], "eyes": [], "luopan": [], "lids": list(LID_CELLS)}
    for y in range(H):
        for x in range(W):
            ch = grid[y][x]
            if ch in BODY_LETTERS:
                layers["body"].append((x, y))
            elif ch == "l":
                layers["luopan"].append((x, y))
            elif ch == "e":
                layers["eyes"].append((x, y))
    layers["body"] += outline(face, face_set)
    layers["beard"] = outline(beard, beard_set)
    return layers, grid


def tal_cells(ox, oy):
    out = []
    for j, row in enumerate(TAL_SHAPE):
        for i, ch in enumerate(row):
            if ch == "#":
                out.append((ox + i, oy + j))
    return out


def runs_d(cells):
    """一组格子 → 每行连续段合成的 path 数据（整数坐标，1 格 = 1 单位）。"""
    rows = {}
    for x, y in cells:
        rows.setdefault(y, []).append(x)
    out = []
    for y in sorted(rows):
        xs = sorted(set(rows[y]))
        start = prev = xs[0]
        for x in xs[1:] + [None]:
            if x is not None and x == prev + 1:
                prev = x
                continue
            w = prev - start + 1
            out.append(f"M{start} {y}h{w}v1h-{w}z")
            if x is not None:
                start = prev = x
    return "".join(out)


def streaks():
    """画面右上角的扫描线拖影（舞台单位，固定随机种子）。"""
    rnd = random.Random(38)
    parts = []
    for _ in range(26):
        y = rnd.randrange(0, 640, 3)
        x0 = rnd.randrange(1000, 1700)
        w = rnd.randrange(160, 620)
        x1 = min(1920, x0 + w)
        parts.append(f"M{x0} {y}h{x1 - x0}v3h-{x1 - x0}z")
    return "".join(parts)


def figure_paths(classes=True):
    layers, _ = build()
    c = (lambda n: f' class="gx-{n}"') if classes else (lambda n: "")
    out = [
        f'<path{c("body")} d="{runs_d(layers["body"])}"/>',
        f'<path{c("beard")} d="{runs_d(layers["beard"])}"/>',
        f'<path{c("luopan")} d="{runs_d(layers["luopan"])}"/>',
        f'<path{c("eyes")} d="{runs_d(layers["eyes"])}"/>',
        f'<path{c("lids")} d="{runs_d(layers["lids"])}"/>',
        f'<path{c("shadow")} d="M7 52h34v1h-34z" opacity=".22"/>',
    ]
    for k, (tx, ty) in enumerate(TALS, 1):
        out.append(f'<path{c("tal tal-" + str(k))} d="{runs_d(tal_cells(tx, ty))}"/>')
    return "".join(out)


def stage_markup():
    return (
        '<svg class="stage" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice" '
        'role="img" data-i18n-aria="gx_aria">\n'
        f'  <path class="gx-streaks" d="{streaks()}"/>\n'
        f'  <g class="gx-figure" transform="translate({FIG_X} {FIG_Y}) scale({CELL})" fill="currentColor">\n'
        f'    {figure_paths(classes=True)}\n'
        '  </g>\n'
        '</svg>'
    )


def avatar_markup():
    # 头像只取头和上半身：格子 x 12–36、y 0–24
    return (
        '<svg class="gx-avatar" viewBox="12 0 24 24" aria-hidden="true">'
        f'<g fill="currentColor">{figure_paths(classes=False)}</g></svg>'
    )


def ascii_preview():
    _, grid = build()
    canvas = [list(row) for row in grid]
    for tx, ty in TALS:
        for x, y in tal_cells(tx, ty):
            if 0 <= x < W and 0 <= y < H:
                canvas[y][x] = "t"
    glyph = {"c": "#", "r": "#", "m": "*", "l": "@", "e": "e", "f": "o", "b": "o", "h": " ", ".": ".", "t": "t"}
    return "\n".join("".join(glyph.get(ch, ch) for ch in row) for row in canvas)


def anchor_fractions():
    """气泡锚点在舞台上的比例：CSS 里的 --ax / --ay。"""
    ax = (FIG_X + ANCHOR_CELL[0] * CELL) / FRAME_W
    ay = (FIG_Y + ANCHOR_CELL[1] * CELL) / FRAME_H
    return round(ax, 4), round(ay, 4)


def write_into_index(path: Path):
    """舞台和气泡锚点写进 index.html；头像 SVG 写进同目录的 app.js（页面脚本已外置，满足 CSP）。"""
    text = path.read_text(encoding="utf-8")
    ax, ay = anchor_fractions()
    text, n1 = re.subn(r"--ax: [0-9.]+;", f"--ax: {ax};", text)
    text, n2 = re.subn(r"--ay: [0-9.]+;", f"--ay: {ay};", text)
    assert n1 == 1 and n2 == 1, (n1, n2)
    start, end = "<!-- gx:stage:start -->", "<!-- gx:stage:end -->"
    a, b = text.index(start) + len(start), text.index(end)
    text = text[:a] + "\n" + stage_markup() + "\n" + text[b:]
    path.write_text(text, encoding="utf-8")

    app = path.with_name("app.js")
    js = app.read_text(encoding="utf-8")
    js_start, js_end = "/* gx:avatar:start */", "/* gx:avatar:end */"
    a, b = js.index(js_start) + len(js_start), js.index(js_end)
    js = js[:a] + "\nconst GX_AVATAR = `" + avatar_markup() + "`;\n" + js[b:]
    app.write_text(js, encoding="utf-8")
    print(f"wrote stage into {path} and avatar into {app}")


def png(out_path: str, scale: int = 12):
    from PIL import Image, ImageDraw

    layers, _ = build()
    img = Image.new("RGB", (W * scale, H * scale), (231, 231, 231))
    d = ImageDraw.Draw(img)
    for name, cells in layers.items():
        for x, y in cells:
            if name == "lids":
                continue
            d.rectangle([x * scale, y * scale, x * scale + scale - 1, y * scale + scale - 1], fill=(5, 5, 5))
    for tx, ty in TALS:
        for x, y in tal_cells(tx, ty):
            d.rectangle([x * scale, y * scale, x * scale + scale - 1, y * scale + scale - 1], fill=(5, 5, 5))
    img.save(out_path)
    print("png:", out_path)


if __name__ == "__main__":
    if "--write" in sys.argv:
        write_into_index(Path(__file__).resolve().parent.parent / "public" / "index.html")
    elif "--png" in sys.argv:
        png(sys.argv[sys.argv.index("--png") + 1])
    else:
        print(ascii_preview())
