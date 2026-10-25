#!/usr/bin/env python3
"""逐张分「编码漂移」与「内容漂移」：给 assets.test.mjs 的红行当证人，不参与判定。

用法: python3 assets/gen/pixelcmp.py <重跑输出目录> <逗号分隔的资产相对路径>
仓内那一份按本文件的位置（assets/gen/ 的上两级）解析，所以从任何 cwd 调用都算得同一回事。
"""
import os
import sys

from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


def main():
    if len(sys.argv) != 3:
        print("用法: pixelcmp.py <重跑输出目录> <逗号分隔的资产相对路径>")
        return 2
    out, rels = sys.argv[1], [r for r in sys.argv[2].split(",") if r]
    n_content = n_encoding = n_unknown = 0
    for rel in rels:
        repo_path, gen_path = os.path.join(ROOT, rel), os.path.join(out, rel)
        if not (os.path.exists(repo_path) and os.path.exists(gen_path)):
            print(f"    · {rel} 读不到盘上或重跑那一份，像素无法比对")
            n_unknown += 1
            continue
        a, b = Image.open(repo_path), Image.open(gen_path)
        if a.size != b.size or a.mode != b.mode:
            print(f"    · 内容漂移 {rel}（尺寸/模式 {a.size}{a.mode} vs {b.size}{b.mode}）")
            n_content += 1
            continue
        pa, pb = a.convert("RGBA").load(), b.convert("RGBA").load()
        w, h = a.size
        n = sum(1 for y in range(h) for x in range(w) if pa[x, y] != pb[x, y])
        if n == 0:
            print(f"    · 编码漂移 {rel}（{w}x{h} 像素逐点相同，只有 PNG 字节不同）")
            n_encoding += 1
        else:
            print(f"    · 内容漂移 {rel}（{n}/{w * h} 个像素不同）")
            n_content += 1
    # 机器可读的一行：调用方（test/assets.test.mjs）拿它当判据，不去解析上面的人话。
    # 少这一行的话，调用方只能按中文文案猜分类 —— 那正是"尺的输出当判据"最脆的一种写法。
    print(f"SUMMARY content={n_content} encoding={n_encoding} unknown={n_unknown}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
