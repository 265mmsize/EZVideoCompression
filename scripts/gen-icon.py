"""앱 아이콘 생성 (build/icon.png, 512x512).

외부 이미지 자산 없이 재현 가능하게 그린다: 둥근 사각형 배경 위에 '압축된 필름 프레임' 을 상징하는
두 개의 가로 막대와 그 사이로 좁아지는 화살표. electron-builder 가 이 PNG 로 Windows .ico 를 만든다.
사용: python3 scripts/gen-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 512
out = Path(__file__).resolve().parent.parent / "build" / "icon.png"
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 배경: 둥근 사각형 (앱 강조색)
d.rounded_rectangle((16, 16, SIZE - 16, SIZE - 16), radius=96, fill=(47, 111, 228, 255))

# 위·아래 필름 막대 (원본 크기)
bar = (255, 255, 255, 255)
d.rounded_rectangle((104, 120, SIZE - 104, 168), radius=16, fill=bar)
d.rounded_rectangle((104, SIZE - 168, SIZE - 104, SIZE - 120), radius=16, fill=bar)

# 가운데: 좁아진 결과 막대 (압축)
d.rounded_rectangle((176, 236, SIZE - 176, 276), radius=16, fill=(255, 255, 255, 230))

# 위·아래에서 가운데로 향하는 화살표 머리
d.polygon([(SIZE // 2 - 40, 184), (SIZE // 2 + 40, 184), (SIZE // 2, 222)], fill=bar)
d.polygon([(SIZE // 2 - 40, SIZE - 184), (SIZE // 2 + 40, SIZE - 184), (SIZE // 2, SIZE - 222)], fill=bar)

out.parent.mkdir(parents=True, exist_ok=True)
img.save(out, "PNG", optimize=True)
print(f"wrote {out} ({out.stat().st_size} bytes)")
