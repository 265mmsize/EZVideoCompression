"""앱 아이콘 생성 (build/icon.png 512×512, build/icon.ico 16~256, build/icon-preview.png).

외부 이미지 자산 없이 재현 가능하게 그린다 (PIL 만 사용). 4배 크기로 그린 뒤 축소해 가장자리를 부드럽게 한다.

디자인
- 둥근 사각형 배경: 남색 → 보라 대각 그라데이션 (앱 강조색 계열), 위쪽에 은은한 하이라이트
- 가운데: 흰 필름 프레임 (양쪽 스프로킷 구멍) 안에 재생 삼각형 → "영상"
- 오른쪽 아래: 작은 원형 배지에 아래 화살표 → "압축·줄이기"
사용: python3 scripts/gen-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

S = 1024  # 작업 해상도 (4배)
OUT_DIR = Path(__file__).resolve().parent.parent / "build"
OUT_DIR.mkdir(parents=True, exist_ok=True)

TOP = (37, 99, 235)      # 파랑
BOTTOM = (109, 40, 217)  # 보라
WHITE = (255, 255, 255, 255)
BADGE = (16, 185, 129)   # 초록 (결과·절감)


def gradient(size: int, c1: tuple[int, int, int], c2: tuple[int, int, int]) -> Image.Image:
    """왼쪽 위 → 오른쪽 아래 대각 그라데이션"""
    base = Image.new("RGB", (size, size))
    px = base.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
    return base


def rounded_mask(size: int, margin: int, radius: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((margin, margin, size - margin, size - margin), radius=radius, fill=255)
    return m


def draw_icon() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # 배경 (그라데이션 + 둥근 사각형 마스크)
    bg = gradient(S, TOP, BOTTOM).convert("RGBA")
    bg.putalpha(rounded_mask(S, 32, 200))
    img.alpha_composite(bg)

    # 위쪽 하이라이트 (아주 연한 흰색 타원)
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse((-200, -520, S + 200, 520), fill=(255, 255, 255, 34))
    hl = hl.filter(ImageFilter.GaussianBlur(40))
    hl.putalpha(Image.eval(hl.getchannel("A"), lambda a: a))
    masked = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    masked.paste(hl, (0, 0), rounded_mask(S, 32, 200))
    img.alpha_composite(masked)

    # 그림자 레이어 (필름 프레임 아래)
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((176, 266, S - 176, S - 246), radius=72, fill=(0, 0, 0, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    img.alpha_composite(shadow)

    d = ImageDraw.Draw(img)
    # 필름 프레임 (흰 둥근 사각형)
    fx0, fy0, fx1, fy1 = 176, 250, S - 176, S - 262
    d.rounded_rectangle((fx0, fy0, fx1, fy1), radius=72, fill=WHITE)
    # 안쪽 화면 (배경색이 비치는 어두운 창)
    ix0, iy0, ix1, iy1 = fx0 + 118, fy0 + 56, fx1 - 118, fy1 - 56
    d.rounded_rectangle((ix0, iy0, ix1, iy1), radius=40, fill=(30, 41, 82, 255))
    # 스프로킷 구멍 (양쪽 4개씩)
    hole_w, hole_h = 44, 60
    n = 4
    gap = (fy1 - fy0 - 2 * 56 - n * hole_h) / (n - 1)
    for i in range(n):
        y = fy0 + 56 + i * (hole_h + gap)
        for cx in (fx0 + 37, fx1 - 37 - hole_w):
            d.rounded_rectangle((cx, y, cx + hole_w, y + hole_h), radius=12, fill=(30, 41, 82, 255))
    # 재생 삼각형
    cx, cy = (ix0 + ix1) / 2 + 14, (iy0 + iy1) / 2
    r = 118
    d.polygon([(cx - r * 0.8, cy - r), (cx - r * 0.8, cy + r), (cx + r * 0.95, cy)], fill=WHITE)

    # 오른쪽 아래 배지: 초록 원 + 아래 화살표 (압축)
    bx, by, br = S - 240, S - 240, 128
    badge_shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(badge_shadow).ellipse((bx - br, by - br + 16, bx + br, by + br + 16), fill=(0, 0, 0, 110))
    badge_shadow = badge_shadow.filter(ImageFilter.GaussianBlur(22))
    img.alpha_composite(badge_shadow)
    d = ImageDraw.Draw(img)
    d.ellipse((bx - br, by - br, bx + br, by + br), fill=BADGE + (255,))
    d.ellipse((bx - br, by - br, bx + br, by + br), outline=WHITE, width=18)
    # 화살표: 세로 막대 + 머리
    d.rounded_rectangle((bx - 22, by - 78, bx + 22, by + 8), radius=14, fill=WHITE)
    d.polygon([(bx - 66, by - 4), (bx + 66, by - 4), (bx, by + 70)], fill=WHITE)
    return img


def main() -> None:
    big = draw_icon()
    icon512 = big.resize((512, 512), Image.LANCZOS)
    png = OUT_DIR / "icon.png"
    icon512.save(png, "PNG", optimize=True)

    # Windows .ico: 여러 크기를 넣는다 (electron-builder 가 그대로 쓴다)
    ico = OUT_DIR / "icon.ico"
    sizes = [256, 128, 64, 48, 32, 24, 16]
    frames = [big.resize((s, s), Image.LANCZOS) for s in sizes]
    frames[0].save(ico, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[1:])

    # 확인용 미리보기 시트 (작은 크기에서도 읽히는지 눈으로 본다)
    sheet_sizes = [256, 128, 64, 48, 32, 16]
    pad = 24
    width = sum(sheet_sizes) + pad * (len(sheet_sizes) + 1)
    sheet = Image.new("RGBA", (width, 256 + pad * 2), (240, 240, 244, 255))
    x = pad
    for s in sheet_sizes:
        sheet.alpha_composite(big.resize((s, s), Image.LANCZOS), (x, pad + (256 - s)))
        x += s + pad
    sheet.save(OUT_DIR / "icon-preview.png", "PNG")
    print(f"wrote {png} ({png.stat().st_size} bytes), {ico} ({ico.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
