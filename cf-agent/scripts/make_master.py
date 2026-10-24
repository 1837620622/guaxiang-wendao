#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
首页「卦先生」像素立绘。

用格子描述轮廓，生成 SVG 路径：
  c 道冠（实心）      f 脸（只画外轮廓，里面透出底色）
  r 道袍（实心）      b 胡须（只画外轮廓，单独一层，会轻轻摆动）
  m 眉、鼻、口（实心小笔画）
  e 眼睛（单独一层，眨眼时隐去）   L 眼皮（只在眨眼时显示）
  l 罗盘（单独一层，会轻微起伏）  t 符纸（三张，单独成组，会漂浮）

格子单位：立绘 48×52 格。页面里用 transform 放大到 1920×1080 的舞台上，
每格 14 个舞台单位。

用法：
  python3 scripts/make_master.py              打印 ASCII 预览
  python3 scripts/make_master.py --write      写进 public/index.html 的标记之间
  python3 scripts/make_master.py --png out.png  输出 PNG 预览（需要 Pillow）
"""
import random
import re
import sys
from pathlib import Path

W, H = 48, 52
FRAME_W, FRAME_H = 1920, 1080   # 舞台坐标（与 viewBox 一致）
FIG_X, FIG_Y, CELL = 1100, 200, 14   # 立绘左上角与每格大小（舞台单位）
ANCHOR_CELL = (25.5, 3.0)       # 气泡尾巴指向的格子：卫道冠的右上方
OX = 3  # 基础坐标以 x=19.5 为中线，整体右移 3 格，中线到 22.5

# ---------- 区域（基础坐标：y, x0, x1，闭区间） ----------
CAP = [(0, 17, 22), (1, 16, 23), (2, 15, 24), (3, 14, 25), (4, 11, 28), (5, 9, 30)]
FACE = [(y, 12, 27) for y in range(6, 14)] + [(14, 13, 26)]
BEARD = [
    (15, 14, 25), (16, 14, 25), (17, 14, 25), (18, 14, 25),
    (19, 15, 24), (20, 15, 24), (21, 15, 24), (22, 15, 24),
    (23, 16, 23), (24, 16, 23), (25, 16, 23),
    (26, 17, 22), (27, 17, 22), (28, 18, 21), (29, 18, 21),
    (30, 19, 20), (31, 19, 20),
]
ROBE = [
    (18, 9, 13), (18, 26, 30),
    (19, 8, 13), (19, 26, 31),
    (20, 7, 13), (20, 26, 32),
    (21, 6, 14), (21, 25, 33),
    (22, 5, 14), (22, 25, 34),
    (23, 5, 15), (23, 24, 34),
    (24, 4, 15), (24, 24, 35),
    (25, 4, 15), (25, 24, 35),
    (26, 4, 16), (26, 23, 35),
    (27, 4, 16), (27, 23, 35),
    (28, 4, 17), (28, 22, 35),
    (29, 4, 17), (29, 22, 35),
    (30, 4, 18), (30, 21, 35),
    (31, 4, 18), (31, 21, 35),
] + [(y, 4, 35) for y in range(32, 45)] + [(y, 3, 36) for y in range(45, 52)]
SASH = [(40, 4, 35)]                       # 腰间丝绦：一道透出底色的横线
FOLDS = []                                 # 不画褶：两道竖线会把下摆切成三根柱子

BROWS = [(7, 14, 16), (7, 23, 25)]
NOSE = [(11, 19, 20)]
MOUTH = [(13, 18, 21)]
EYES = [(8, 15, 16), (9, 15, 16), (8, 23, 24), (9, 23, 24)]
LIDS = [(9, 15, 16), (9, 23, 24)]          # 眨眼时才显示的眼皮（不写进格子，避免覆盖眼睛）

LUO_C = (12, 34)                           # 罗盘圆心（最终坐标）
LUO_R2 = 4.8 * 4.8                         # 外半径²
LUO_HALO2 = 6.3 * 6.3                      # 罗盘周围让出的空隙
WHISK_HANDLE = [(36, 36), (37, 33), (38, 30), (39, 27), (39, 24), (40, 21), (41, 19)]
WHISK_FLUFF = (41, 13, 3.3, 4.3)          # 拂尘头：中心 x, y，半宽、半高

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
TALS = [(43, 5), (43, 19), (43, 33)]       # 三张符纸左上角（最终坐标，右侧让出拂尘）


def cells_of(spans):
    out = []
    for y, x0, x1 in spans:
        out += [(x + OX, y) for x in range(x0, x1 + 1)]
    return out


def line_cells(x0, y0, x1, y1):
    """两点之间的整数格子（沿较长的那一轴取样）。"""
    n = max(abs(x1 - x0), abs(y1 - y0))
    return [(round(x0 + (x1 - x0) * i / n), round(y0 + (y1 - y0) * i / n)) for i in range(n + 1)]


def build():
    grid = [["."] * W for _ in range(H)]

    def paint(letter, cells):
        for x, y in cells:
            if 0 <= x < W and 0 <= y < H:
                grid[y][x] = letter

    cap = cells_of(CAP)
    face = cells_of(FACE)
    robe = [(x + OX, y) for (y, x0, x1) in ROBE for x in range(x0, x1 + 1)]
    beard = cells_of(BEARD)
    face_set, beard_set = set(face), set(beard)

    paint("c", cap)
    paint("f", face)
    paint("r", robe)
    paint(".", [(x + OX, y) for (y, x0, x1) in SASH for x in range(x0, x1 + 1)])
    paint(".", FOLDS)  # FOLDS 已是最终坐标
    # 两道透缝：把宽袖从肩上分出来
    paint(".", line_cells(15, 21, 12, 38) + line_cells(30, 21, 34, 37))
    paint("b", beard)
    paint("m", cells_of(BROWS) + cells_of(NOSE) + cells_of(MOUTH))
    paint("e", cells_of(EYES))

    # 拂尘：从右手斜向上，头部是一团带两道透缝的毛
    wx, wy, rx, ry = WHISK_FLUFF
    for (hx, hy) in WHISK_HANDLE:
        paint("w", [(hx, hy)])
    for y in range(int(wy - ry) - 1, int(wy + ry) + 2):
        for x in range(int(wx - rx) - 1, int(wx + rx) + 2):
            if ((x - wx) / rx) ** 2 + ((y - wy) / ry) ** 2 <= 1:
                if y in (int(wy) - 1, int(wy) + 1):
                    grid[y][x] = "."
                else:
                    grid[y][x] = "w"

    cx, cy = LUO_C
    for y in range(H):
        for x in range(W):
            d2 = (x - cx) ** 2 + (y - cy) ** 2
            if d2 <= LUO_HALO2 and d2 > LUO_R2:
                grid[y][x] = "."
    for y in range(H):
        for x in range(W):
            d2 = (x - cx) ** 2 + (y - cy) ** 2
            if d2 <= LUO_R2:
                # 中心一点实心，中间与外圈两道环线透出底色
                if d2 <= 1.5:
                    grid[y][x] = "l"
                elif 9 <= d2 <= 11:
                    grid[y][x] = "."
                else:
                    grid[y][x] = "l"

    # 轮廓：脸、胡须只保留边界
    def outline(cells, region):
        out = []
        for x, y in cells:
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if (nx, ny) not in region:
                    out.append((x, y))
                    break
        return out

    layers = {"body": [], "beard": [], "eyes": [], "luopan": [], "lids": []}
    for y in range(H):
        for x in range(W):
            ch = grid[y][x]
            if ch in ("c", "r", "m", "w"):
                layers["body"].append((x, y))
            elif ch == "l":
                layers["luopan"].append((x, y))
            elif ch == "e":
                layers["eyes"].append((x, y))
    layers["body"] += outline(face, face_set)
    layers["beard"] = outline(beard, beard_set)
    layers["lids"] = [(x + OX, y) for (y, x0, x1) in LIDS for x in range(x0, x1 + 1)]
    layers["lids"] = [(x, y) for x, y in layers["lids"] if x < W]
    # 罗盘：只留 "l" 格（上面已经把环线挖掉）
    layers["luopan"] = [(x, y) for x, y in layers["luopan"]]
    # 眼皮：眼睛行的下一行是闭眼线，它本身就在眼睛格里，眨眼时单独显示
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
        f'<path{c("shadow")} d="M11 52h23v1h-23z" opacity=".22"/>',
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
    return (
        '<svg class="gx-avatar" viewBox="11 0 22 22" aria-hidden="true">'
        f'<g fill="currentColor">{figure_paths(classes=False)}</g></svg>'
    )


def ascii_preview():
    layers, grid = build()
    lines = []
    for j in range(H):
        row = []
        for i in range(W):
            ch = grid[j][i]
            row.append("#" if ch in ("c", "r", "m", "l", "e") else ("o" if ch == "f" or ch == "b" else "."))
        lines.append("".join(row))
    # 符纸叠在右侧
    canvas = [list(l) for l in lines]
    for tx, ty in TALS:
        for x, y in tal_cells(tx, ty):
            if 0 <= x < W and 0 <= y < H:
                canvas[y][x] = "t"
    return "\n".join("".join(r) for r in canvas)


def anchor_fractions():
    """气泡锚点在舞台上的比例：CSS 里的 --ax / --ay。"""
    ax = (FIG_X + ANCHOR_CELL[0] * CELL) / FRAME_W
    ay = (FIG_Y + ANCHOR_CELL[1] * CELL) / FRAME_H
    return round(ax, 4), round(ay, 4)


def write_into_index(path: Path):
    text = path.read_text(encoding="utf-8")
    ax, ay = anchor_fractions()
    text, n1 = re.subn(r"--ax: [0-9.]+;", f"--ax: {ax};", text)
    text, n2 = re.subn(r"--ay: [0-9.]+;", f"--ay: {ay};", text)
    assert n1 == 1 and n2 == 1, (n1, n2)
    start, end = "<!-- gx:stage:start -->", "<!-- gx:stage:end -->"
    a, b = text.index(start) + len(start), text.index(end)
    text = text[:a] + "\n" + stage_markup() + "\n" + text[b:]
    js_start, js_end = "/* gx:avatar:start */", "/* gx:avatar:end */"
    a, b = text.index(js_start) + len(js_start), text.index(js_end)
    text = text[:a] + "\nconst GX_AVATAR = `" + avatar_markup() + "`;\n" + text[b:]
    path.write_text(text, encoding="utf-8")
    print(f"wrote stage + avatar into {path}")


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
