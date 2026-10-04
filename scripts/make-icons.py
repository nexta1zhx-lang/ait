#!/usr/bin/env python3
"""
生成 Android 的应用图标 + 启动图（纯代码画，不需要设计稿）。

为什么要脚本：图标要 5 档密度 × 3 种（普通 / 圆形 / 自适应前景），启动图要
2 个方向 × 5 档密度 + 1 张兜底，再加上网页 favicon —— 一共 27 个文件，
手改必然漏掉某一档，然后就是「我的手机上是旧图标」这种找半天的怪事。

用法：
    python3 scripts/make-icons.py             # 重新生成全部
    python3 scripts/make-icons.py --dry-run   # 只打印会写哪些文件，不落盘

改配色时，这几处**必须一起改**：
    · 下面的 `BG` / `ACCENT` 等常量
    · `android/app/src/main/res/values/colors.xml` 的 `app_bg`
    · `android/app/src/main/res/values/ic_launcher_background.xml`
    · `capacitor.config.json` 的 `android.backgroundColor` / `StatusBar.backgroundColor`
    · `frontend/src/style.css` 的 `--bg` / `--accent`
    · `frontend/src/native.ts` 的 `APP_BG`

依赖 Pillow：
    python3 -m pip install --user Pillow
"""

import argparse
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:  # pragma: no cover
    sys.exit('缺 Pillow：python3 -m pip install --user Pillow')

# ---------------------------------------------------------------- 配色与几何

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
PUBLIC = os.path.join(ROOT, 'frontend', 'public')

BG = (8, 9, 11)  # #08090b 前端 --bg
BG_TOP = (20, 22, 28)  # 顶部略亮，做个几乎看不出来的竖向渐变
ACCENT = (211, 181, 131)  # #d3b583 前端 --accent
ACCENT_MID = (168, 144, 104)
ACCENT_DIM = (120, 103, 74)

SS = 4  # 图标超采样倍数（画完再缩，边缘才干净）

# 三根递增的蜡烛：中心 x、实体上沿、实体下沿、影线上沿、影线下沿、颜色
# 坐标都是 0..1 的**相对值**，画的时候乘以方框边长 → 任意尺寸共用一套
#
# 调比例的几个坑（都是踩过的）：
#   · 影线要**细**（≈0.014）。粗一点看着就不是影线了，而是实体上的一个方块角。
#   · 实体别太宽也别挨太近，否则三根会糊成一整块（尤其 48px 那档）。
CANDLES = (
    (0.17, 0.60, 0.86, 0.52, 0.94, ACCENT_DIM),
    (0.50, 0.42, 0.72, 0.33, 0.82, ACCENT_MID),
    (0.83, 0.12, 0.56, 0.03, 0.66, ACCENT),
)

LAUNCHER = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
FOREGROUND = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
SPLASH_PORT = {
    'mdpi': (320, 480),
    'hdpi': (480, 800),
    'xhdpi': (720, 1280),
    'xxhdpi': (960, 1600),
    'xxxhdpi': (1280, 1920),
}
SPLASH_LAND = {
    'mdpi': (480, 320),
    'hdpi': (800, 480),
    'xhdpi': (1280, 720),
    'xxhdpi': (1600, 960),
    'xxxhdpi': (1920, 1280),
}

# ---------------------------------------------------------------- 画笔


def vertical_gradient(w, h, top=BG_TOP, bottom=BG):
    """竖向渐变底（1×h 拉伸成 w×h，比一行行画快，也没有条带）"""
    strip = Image.new('RGB', (1, h))
    px = strip.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return strip.resize((w, h), Image.BICUBIC).convert('RGBA')


def add_glow(img, cx, cy, r, alpha=44):
    """在 (cx,cy) 糊一团很淡的金色光晕 —— 纯色底太「平」，加一点质感"""
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(
        [cx - r, cy - r, cx + r, cy + r], fill=(*ACCENT, alpha)
    )
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(r * 0.6)))


def draw_mark(d, x0, y0, size):
    """在以 (x0,y0) 为左上角、边长 size 的方框里画那三根蜡烛"""
    body_w = size * 0.140
    wick_w = size * 0.014
    for cx, b_top, b_bot, w_top, w_bot, col in CANDLES:
        x = x0 + size * cx
        d.rectangle([x - wick_w, y0 + size * w_top, x + wick_w, y0 + size * w_bot], fill=col)
        d.rectangle([x - body_w, y0 + size * b_top, x + body_w, y0 + size * b_bot], fill=col)


def render_mark_only(px, frac=0.86):
    """
    透明底的「图形本身」（带光晕），边长 px。

    启动图 / 自适应图标前景都拿它去贴，避免各画一遍导致比例不一致。
    """
    S = px * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    add_glow(img, S / 2, S / 2, S * 0.46)
    m = S * frac
    draw_mark(ImageDraw.Draw(img), (S - m) / 2, (S - m) / 2, m)
    return img.resize((px, px), Image.LANCZOS)


# ---------------------------------------------------------------- 三种图标


def render_launcher(size, round_icon=False):
    """
    传统图标（Android 7 及以下直接用这张；8+ 走自适应图标，这张是兜底）。

    深色圆角方 / 圆形底 + 居中图形，跟启动图同一套视觉。
    """
    S = size * SS
    img = vertical_gradient(S, S).copy()
    add_glow(img, S * 0.5, S * 0.54, S * 0.40)
    m = S * 0.60
    draw_mark(ImageDraw.Draw(img), (S - m) / 2, (S - m) / 2 + S * 0.01, m)

    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    if round_icon:
        md.ellipse([0, 0, S - 1, S - 1], fill=255)
    else:
        md.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.22, fill=255)

    out = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def render_foreground(size):
    """
    自适应图标（Android 8+）的**前景层**：必须是透明底。

    系统会把整张图按当前启动器形状裁剪，**看得见的只有中间 72/108** ——
    所以图形只占 0.48，四周都是留给裁切的余量。画满了的话圆角/圆形启动器上会被切掉两头。
    """
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    m = S * 0.48
    draw_mark(ImageDraw.Draw(img), (S - m) / 2, (S - m) / 2, m)
    return img.resize((size, size), Image.LANCZOS)


def render_splash(w, h):
    """
    启动图（Android 11 及以下由 `AppTheme.NoActionBarLaunch` 的 `android:background`
    铺出来；12+ 走系统那套 `windowSplashScreenBackground`，这张用不上）。

    底色跟 App 主背景一致 → 从启动图切到页面是**无缝**的，不会有白闪。
    图形按**短边**的 30% 画，横竖屏看起来都一样大。
    """
    img = vertical_gradient(w, h)
    logo_px = max(48, int(min(w, h) * 0.30))
    logo = render_mark_only(logo_px, frac=0.78)
    img.alpha_composite(logo, ((w - logo_px) // 2, (h - logo_px) // 2))
    return img.convert('RGB')


def render_favicon(size):
    """网页标签页图标（跟 App 图标同一套）"""
    return render_launcher(size)


# ---------------------------------------------------------------- 主流程


def main():
    ap = argparse.ArgumentParser(description='生成 Android 图标与启动图')
    ap.add_argument('--dry-run', action='store_true', help='只打印，不写文件')
    args = ap.parse_args()

    targets = []  # (路径, 图片)

    for name, px in LAUNCHER.items():
        targets.append((f'mipmap-{name}/ic_launcher.png', render_launcher(px)))
        targets.append((f'mipmap-{name}/ic_launcher_round.png', render_launcher(px, True)))
    for name, px in FOREGROUND.items():
        targets.append((f'mipmap-{name}/ic_launcher_foreground.png', render_foreground(px)))
    for name, (w, h) in SPLASH_PORT.items():
        targets.append((f'drawable-port-{name}/splash.png', render_splash(w, h)))
    for name, (w, h) in SPLASH_LAND.items():
        targets.append((f'drawable-land-{name}/splash.png', render_splash(w, h)))
    # 兜底那张：跟 drawable-land-mdpi 同尺寸，保持原样别改（改了会影响极端情况下的布局）
    targets.append(('drawable/splash.png', render_splash(480, 320)))

    total = 0
    for rel, img in targets:
        path = os.path.join(RES, rel)
        if args.dry_run:
            print(f'  would write  {rel:<48} {img.size[0]}x{img.size[1]}')
        else:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            img.save(path, 'PNG', optimize=True)
            print(f'  wrote  {rel:<48} {img.size[0]}x{img.size[1]}')
        total += 1

    fav = os.path.join(PUBLIC, 'favicon.png')
    if args.dry_run:
        print(f'  would write  frontend/public/favicon.png')
    else:
        os.makedirs(PUBLIC, exist_ok=True)
        render_favicon(64).save(fav, 'PNG', optimize=True)
        print('  wrote  frontend/public/favicon.png')
    total += 1

    print(f'\n{"将生成" if args.dry_run else "已生成"} {total} 张图')


if __name__ == '__main__':
    main()
