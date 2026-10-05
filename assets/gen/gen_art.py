#!/usr/bin/env python3
"""数和 · KAKURASU 的美术资产工厂（可复现，零网络，只用 Pillow + 标准库）。

视觉母题（由玩法决定，不是凭空编）：
  盘面是 4x4 的带权棋盘 —— 一个被选中的格子把它的**列号**付进行线索、把它的**行号**付进列线索。
  所以图标就是这件事的最小快照：暗底、铜黄选中块（#e8b855→#b8842b，js/view.js 画的就是这两个值）、
  左侧与顶部两排线索刻度（满足=青蓝 #78dcff，未满足=暗铜），外框一道 2px 铜边（同 ctx 的
  rgba(216,161,60,0.55) 描边）。

产出的三类东西：
  icons/       favicon 16/32、apple-touch-icon 180、PWA 192/512、maskable 512、母图 1024、og 1200x630
  assets/img/  游戏内真正贴到画布上的纹理与发光 sprite（board-texture 可无缝平铺）
  两者都是真 PNG（本脚本写完会自证：解 IHDR 读宽高、拒绝 0 字节）。maskable 那一枚还多一道
  自证：量真实像素，母题（铜块 + 青蓝刻度）必须落在中央 80% 安全区内，越界就非零退出 ——
  启动器按形状裁 maskable（圆形最常见），坐标记错一次就把线索刻度切掉，而宽高照样对得上。

确定性：所有随机都走同一个 LCG（种子 --seed，默认 20261002），同一命令跑两次逐字节相同。

用法: python3 assets/gen/gen_art.py [--seed N] [--out .]
"""
from __future__ import annotations

import argparse
import math
import os
import struct
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ---------------------------------------------------------------- 主题令牌（与 css/game.css 同源）
BG = (20, 22, 26, 255)          # --bg #14161a
BG_DEEP = (16, 18, 23, 255)     # --bg #101217
PANEL = (24, 27, 33, 255)       # js/view.js 的 #181b21
BRASS = (216, 161, 60, 255)     # --brass
BRASS_HI = (232, 184, 85, 255)  # 选中块渐变顶色
BRASS_LO = (184, 132, 43, 255)  # 选中块渐变底色
CYAN = (120, 220, 255, 255)     # --cyan
INK = (230, 233, 239, 255)      # --ink
INK_DIM = (143, 152, 168, 255)  # --ink-dim
LINE = (226, 232, 240, 26)      # rgba(226,232,240,0.10)

# 装饰用的一个自洽盘面：行线索 [5,3,1,6]、列线索 [4,4,2,5]，两边总和都是 15（带权和必须相等）
BOARD = [
    [1, 0, 0, 1],
    [0, 0, 1, 0],
    [1, 0, 0, 0],
    [0, 1, 0, 1],
]
ROW_CLUES = [5, 3, 1, 6]
COL_CLUES = [4, 4, 2, 5]


class Lcg:
    """数值配方 (a, c, m) = (1664525, 1013904223, 2^32)。不用 random/Math.random，保证可复现。"""

    def __init__(self, seed: int):
        self.s = seed & 0xFFFFFFFF

    def next(self) -> int:
        self.s = (1664525 * self.s + 1013904223) & 0xFFFFFFFF
        return self.s

    def unit(self) -> float:
        return self.next() / 4294967296.0


def mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(4))


def vgrad(size, top, bottom):
    w, h = size
    g = Image.new("RGBA", (w, h))
    dr = ImageDraw.Draw(g)
    for y in range(h):
        dr.line((0, y, w, y), fill=mix(top, bottom, y / max(1, h - 1)))
    return g


def round_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def vertical_pad(img, pad):
    """上下各留 pad 的空白，用于把棋盘放进 1024 母图的安全区。"""
    w, h = img.size
    out = Image.new("RGBA", (w, h + pad * 2), (0, 0, 0, 0))
    out.paste(img, (0, pad), img)
    return out


def font_cjk(size: int, cache={}):
    """中文字体按候选表实测解析；解析不到就退回拉丁，调用方只画拉丁，绝不画豆腐块。"""
    if size in cache:
        return cache[size]
    cands = [
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/PingFang.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ]
    for p in cands:
        if os.path.exists(p):
            try:
                f = ImageFont.truetype(p, size)
                cache[size] = (f, True)
                return cache[size]
            except OSError:
                continue
    for p in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf"):
        if os.path.exists(p):
            cache[size] = (ImageFont.truetype(p, size), False)
            return cache[size]
    cache[size] = (ImageFont.load_default(size), False)
    return cache[size]


# ---------------------------------------------------------------- 图标主体
def board_icon(S: int, rng: Lcg, *, full_bleed=False, marks_only=False) -> Image.Image:
    """S x S 的棋盘图标。full_bleed=True 时背景铺满四角（maskable 用），否则圆角透明。

    低 alpha 的东西一律画在 fx 叠加层上再 alpha_composite —— 实测 Pillow 11.3 的
    ImageDraw 即便以 "RGBA" 模式创建，填充仍是替换像素：直接画会把空格写成半透明洞。
    """
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    radius = int(S * (0.0 if full_bleed else 0.185))
    bg = vgrad((S, S), (26, 29, 36, 255), BG_DEEP)
    img.paste(bg, (0, 0), round_mask((S, S), radius) if radius else None)
    fx = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    fd = ImageDraw.Draw(fx)

    # 顶部/左侧的线索刻度带（占 1 格，和 js/view.js 的 CLUE_RATIO 同一个意思）
    inset = S * (0.14 if full_bleed else 0.085)
    box = S - inset * 2
    cells = 5  # 4 格棋盘 + 1 格线索槽
    u = box / cells
    gx, gy = inset, inset

    if S >= 120:
        for i in range(4):
            # 列线索：顶排短横；行线索：左排短竖。满足的画青蓝，其余画暗铜。
            dr.rounded_rectangle((gx + (i + 1) * u + u * 0.28, gy + u * 0.30,
                                  gx + (i + 1) * u + u * 0.72, gy + u * 0.52),
                                 radius=max(1, u * 0.06),
                                 fill=CYAN if sum(BOARD[r][i] * (r + 1) for r in range(4)) == COL_CLUES[i] else (138, 102, 32, 255))
            dr.rounded_rectangle((gx + u * 0.30, gy + (i + 1) * u + u * 0.28,
                                  gx + u * 0.52, gy + (i + 1) * u + u * 0.72),
                                 radius=max(1, u * 0.06),
                                 fill=CYAN if sum(BOARD[i][c] * (c + 1) for c in range(4)) == ROW_CLUES[i] else (138, 102, 32, 255))

    # 4x4 格：选中块是纵向渐变 + 一道内高光，空块只有极淡的描底
    marks_only = marks_only or S < 96
    for r in range(4):
        for c in range(4):
            x0 = gx + (c + 1) * u
            y0 = gy + (r + 1) * u
            pad = u * 0.09
            rad = max(1, u * 0.14)
            if BOARD[r][c]:
                tw = max(2, int(u - pad * 2))
                g = vgrad((tw, tw), BRASS_HI, BRASS_LO)
                t = Image.new("RGBA", (max(2, int(u)), max(2, int(u))), (0, 0, 0, 0))
                t.paste(g, (int(pad), int(pad)), round_mask((tw, tw), rad))
                img.alpha_composite(t, (int(x0), int(y0)))
                if S >= 120:
                    # 内高光：同一条线，画在叠加层上才是"提亮"而不是"挖白"
                    fd.line((x0 + pad + u * 0.16, y0 + pad + u * 0.14,
                             x0 + pad + tw - u * 0.16, y0 + pad + u * 0.14),
                            fill=(255, 238, 205, 92), width=max(1, int(u * 0.045)))
            else:
                fd.rounded_rectangle((x0 + pad, y0 + pad, x0 + u - pad, y0 + u - pad),
                                     radius=rad, fill=(255, 255, 255, 6))

    # 网格线 + 铜色外框（js/view.js 最后画这两层，顺序照它）
    if S >= 64:
        lw = max(1, int(S * 0.006))
        for i in range(5):
            fd.line((gx + (i + 1) * u, gy + u, gx + (i + 1) * u, gy + u + 4 * u), fill=LINE, width=lw)
            fd.line((gx + u, gy + (i + 1) * u, gx + u + 4 * u, gy + (i + 1) * u), fill=LINE, width=lw)
        frame = max(1, int(S * 0.018))
        fd.rectangle((gx + u - frame / 2, gy + u - frame / 2, gx + u + 4 * u + frame / 2, gy + u + 4 * u + frame / 2),
                     outline=(216, 161, 60, 160), width=frame)
    elif S >= 32:
        frame = max(1, int(S * 0.03))
        fd.rectangle((gx + u, gy + u, gx + 5 * u, gy + 5 * u), outline=(216, 161, 60, 190), width=frame)
    else:
        # 16px：4x4 读不出，退成母题的最小可辨形 —— 铜块 + 青块对角，中间留一道暗缝
        q = S * 0.2
        dr.rectangle((gx + q, gy + q, gx + 2.8 * q, gy + 2.8 * q), fill=BRASS)
        dr.rectangle((gx + 3.2 * q, gy + 3.2 * q, gx + 5 * q, gy + 5 * q), fill=CYAN)
    img.alpha_composite(fx)
    if radius:
        # 圆角外的东西（高光溢出、外框）按 mask 再裁一次，四角保持真透明
        img.putalpha(Image.composite(img.split()[3], Image.new("L", (S, S), 0), round_mask((S, S), radius)))
    return img


def save_png(img: Image.Image, path: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "PNG", optimize=True)


def fit_font(text, max_w, start):
    """按可用宽度实测缩号：PIL 不会自己换行也不会裁字，溢出就是被静切掉。"""
    size = start
    f, cjk = font_cjk(size)
    while size > 28 and f.getlength(text) > max_w:
        size -= 4
        f, cjk = font_cjk(size)
    return f, cjk, size


def og_card(S_W=1200, S_H=630) -> Image.Image:
    img = Image.new("RGBA", (S_W, S_H), BG_DEEP)
    # 底光：从左上打下来的一道径向，和 body 的 radial-gradient 同一走向
    glow = Image.new("L", (S_W, S_H), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-S_W * 0.2, -S_H * 0.6, S_W * 0.8, S_H * 0.9), fill=26)
    glow = glow.filter(ImageFilter.GaussianBlur(60))
    img.paste(Image.new("RGBA", (S_W, S_H), (34, 38, 47, 255)), (0, 0), glow)
    dr = ImageDraw.Draw(img)

    icon = board_icon(430, Lcg(7))
    img.alpha_composite(icon, (64, int((S_H - 430) / 2)))

    tx = 540
    avail = S_W - tx - 48
    _, has_cjk = font_cjk(34)
    title = "数和 · KAKURASU" if has_cjk else "KAKURASU"
    f_title, _, t_size = fit_font(title, avail, 96)
    f_sub, _ = font_cjk(34)
    f_num, _ = font_cjk(26)
    ty = 132
    dr.text((tx, ty), title, font=f_title, fill=INK)
    y = ty + t_size + 34
    for line in (("每行每列的带权和等于线索" if has_cjk else "weighted row and column sums"),
                 ("解数由两条互相独立的计数器算出" if has_cjk else "solution counts from two independent counters")):
        dr.text((tx, y), line, font=f_sub, fill=INK_DIM)
        y += 56
    facts = [
        ("65536", "4x4 全部棋盘"),
        ("64959", "按线索对归类"),
        ("64382", "唯一解类"),
        ("577", "多解类"),
    ]
    y += 14
    for num, lab in facts:
        dr.rounded_rectangle((tx, y, tx + 6, y + 30), radius=3, fill=BRASS)
        dr.text((tx + 22, y - 4), num, font=f_sub, fill=BRASS)
        dr.text((tx + 132, y + 1), lab if has_cjk else "", font=f_num, fill=INK_DIM)
        y += 46
    # 右下角的棋盘小样，让卡片即使被裁成 1.91:1 之外也仍有母题
    small = board_icon(150, Lcg(11), full_bleed=True)
    img.alpha_composite(small, (S_W - 190, S_H - 190))
    edge = Image.new("RGBA", (S_W, S_H), (0, 0, 0, 0))
    ImageDraw.Draw(edge).line((0, S_H - 5, S_W, S_H - 5), fill=(216, 161, 60, 140), width=5)
    img.alpha_composite(edge)
    return img


def board_texture(S=256, seed=0) -> Image.Image:
    """可无缝平铺的盘面底纹：整数频率的正弦格点噪声（所以左右/上下边缘天然接得上）。"""
    rng = Lcg(seed)
    phase = [(rng.unit() * math.tau, rng.unit() * math.tau) for _ in range(4)]
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    px = img.load()
    tau2 = math.tau
    for y in range(S):
        for x in range(S):
            u, v = x / S * tau2, y / S * tau2
            n = 0.0
            for k, (pu, pv) in enumerate(phase):
                n += math.sin(u * (k + 1) + pu) * math.cos(v * (k + 2) + pv)
            n = (n / 4.0 + 1.0) / 2.0            # 0..1
            a = int(4 + n * 13)                  # 极淡：最多 alpha 17
            px[x, y] = (226, 232, 240, a)
    # 一层 32px 的点阵，给"格子有重量"的错觉；同样按 32 整除 S 保证接缝
    dr = ImageDraw.Draw(img)
    for y in range(0, S, 32):
        for x in range(0, S, 32):
            dr.point((x, y), fill=(226, 232, 240, 22))
    return img


def glow_sprite(S=64, color=CYAN) -> Image.Image:
    """径向发光 sprite：中心实、边缘透明，画涟漪/提示脉冲时按 tint 选色。"""
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    px = img.load()
    c = S / 2.0
    for y in range(S):
        for x in range(S):
            d = math.hypot(x + 0.5 - c, y + 0.5 - c) / c
            a = 0.0 if d >= 1.0 else (1.0 - d) ** 2.4
            px[x, y] = (color[0], color[1], color[2], int(a * 255))
    return img


SAFE_INSET = 0.10  # maskable 的 80% 安全区：四周各让出 10%，形状遮罩（最常见是圆）切不到母题


def motif_bbox(img):
    """母题（铜块与青蓝刻度那两种颜色）的包围盒。背景不算内容：maskable 的背景本来就要铺满四角。"""
    rgb = img.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            d_brass = abs(r - BRASS[0]) + abs(g - BRASS[1]) + abs(b - BRASS[2])
            d_cyan = abs(r - CYAN[0]) + abs(g - CYAN[1]) + abs(b - CYAN[2])
            if min(d_brass, d_cyan) < 70:
                if x < minx:
                    minx = x
                if x > maxx:
                    maxx = x
                if y < miny:
                    miny = y
                if y > maxy:
                    maxy = y
    return minx, miny, maxx, maxy


def check_safe_zone(img, rel):
    """量一次真实像素，返回（读数, 是否越界）。不靠画的时候记住坐标 —— 记住的坐标会漂。"""
    w, h = img.size
    minx, miny, maxx, maxy = motif_bbox(img)
    lo_x, hi_x = round(w * SAFE_INSET), round(w * (1 - SAFE_INSET)) - 1
    lo_y, hi_y = round(h * SAFE_INSET), round(h * (1 - SAFE_INSET)) - 1
    if maxx < minx:
        return f"{rel}: 一个母题像素都没找到（配色改了？），无从判定安全区", True
    bleed = minx < lo_x or maxx > hi_x or miny < lo_y or maxy > hi_y
    return (
        f"{rel} {w}x{h}：母题 bbox=({minx},{miny})-({maxx},{maxy})，"
        f"允许 x/y ∈ [{lo_x}..{hi_x}]/[{lo_y}..{hi_y}]，"
        f"四边留白 L{minx} T{miny} R{w - 1 - maxx} B{h - 1 - maxy} "
        f"⇒ {'越界，圆形遮罩会切掉' if bleed else '在圈内'}",
        bleed,
    )


def verify(root: str, names):
    """自证：解 IHDR 读宽高、拒绝 0 字节。任何一张不合格就非零退出。"""
    bad = []
    print(f"{'路径':<38}{'宽':>6}{'高':>6}{'字节':>10}")
    for rel in names:
        p = os.path.join(root, rel)
        if not os.path.exists(p):
            bad.append(f"{rel}: 不存在")
            continue
        size = os.path.getsize(p)
        with open(p, "rb") as fh:
            head = fh.read(24)
        if size == 0:
            bad.append(f"{rel}: 0 字节")
            continue
        if head[:8] != b"\x89PNG\r\n\x1a\n":
            bad.append(f"{rel}: 不是 PNG 魔数")
            continue
        w, h = struct.unpack(">II", head[16:24])
        print(f"{rel:<38}{w:>6}{h:>6}{size:>10}")
        if min(w, h) < 16:
            bad.append(f"{rel}: 尺寸异常 {w}x{h}")
    if bad:
        for b in bad:
            print("FAIL", b, file=sys.stderr)
        return 1
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20261002)
    ap.add_argument("--out", default=os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
    args = ap.parse_args()
    root = args.out
    rng = Lcg(args.seed)

    names = []
    # 母图：满幅无圆角无透明（将来进 asset catalog 也不会被校验打回）
    master = board_icon(1024, rng, full_bleed=True)
    master = vertical_pad(master, 0)
    save_png(master, os.path.join(root, "icons/master-1024.png"))
    names.append("icons/master-1024.png")

    for S, rel in [(512, "icons/icon-512.png"), (192, "icons/icon-192.png"),
                   (180, "icons/apple-touch-icon.png"), (96, "icons/icon-96.png")]:
        save_png(board_icon(S, Lcg(args.seed + S)), os.path.join(root, rel))
        names.append(rel)

    # 小尺寸直接从矢量母题现画（降采样会把 4x4 糊成一片），16/32 用简化形
    for S, rel in [(32, "icons/favicon-32.png"), (16, "icons/favicon-16.png"), (48, "icons/icon-48.png")]:
        save_png(board_icon(S, Lcg(args.seed + S)), os.path.join(root, rel))
        names.append(rel)

    maskable = board_icon(512, Lcg(args.seed + 5), full_bleed=True)
    save_png(maskable, os.path.join(root, "icons/icon-maskable-512.png"))
    names.append("icons/icon-maskable-512.png")
    safe_msg, safe_bleed = check_safe_zone(maskable, "icons/icon-maskable-512.png")

    save_png(og_card(), os.path.join(root, "icons/og-card.png"))
    names.append("icons/og-card.png")

    # 游戏内资产：画布真的会用到这三张（纹理 + 两张涟漪 sprite）
    save_png(board_texture(256, args.seed), os.path.join(root, "assets/img/board-texture.png"))
    names.append("assets/img/board-texture.png")
    save_png(glow_sprite(64, CYAN), os.path.join(root, "assets/img/glow-cyan-64.png"))
    names.append("assets/img/glow-cyan-64.png")
    save_png(glow_sprite(64, BRASS_HI), os.path.join(root, "assets/img/glow-brass-64.png"))
    names.append("assets/img/glow-brass-64.png")

    print(f"seed={args.seed}")
    print(f"[安全区] {safe_msg}")
    rc = verify(root, names)
    if safe_bleed:
        print("FAIL maskable 的母题越出 80% 安全区：换成圆形/圆角遮罩的启动器会切掉它", file=sys.stderr)
        return 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
