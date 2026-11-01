/**
 * 컬러 피커와 화면 좌표 변환 (순수 함수).
 */
import type { View } from './playerMath';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** 색상 모델 변환. 색조는 0~360, 채도·명도·밝기는 0~100 (%) */
export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) };
  const s = d / (1 - Math.abs(2 * l - 1));
  return {
    h: Math.round(hueOf(rn, gn, bn, max, d)),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

export function rgbToHsv({ r, g, b }: Rgb): { h: number; s: number; v: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, v: Math.round(max * 100) };
  return {
    h: Math.round(hueOf(rn, gn, bn, max, d)),
    s: Math.round((d / max) * 100),
    v: Math.round(max * 100),
  };
}

function hueOf(r: number, g: number, b: number, max: number, d: number): number {
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/**
 * 화면 좌표(요소 안)를 원본 이미지 픽셀로 바꾼다. 이미지는 요소 안에 맞춤(contain)으로 놓이고, view 로 확대·이동된다.
 * 이미지 바깥(여백)이면 null.
 */
export function screenToImagePixel(
  view: View,
  boxW: number,
  boxH: number,
  natW: number,
  natH: number,
  x: number,
  y: number,
): { x: number; y: number } | null {
  if (natW <= 0 || natH <= 0 || boxW <= 0 || boxH <= 0) return null;
  const cx = (x - view.tx) / view.scale;
  const cy = (y - view.ty) / view.scale;
  const fit = Math.min(boxW / natW, boxH / natH);
  const ox = (boxW - natW * fit) / 2;
  const oy = (boxH - natH * fit) / 2;
  const ix = Math.floor((cx - ox) / fit);
  const iy = Math.floor((cy - oy) / fit);
  if (ix < 0 || iy < 0 || ix >= natW || iy >= natH) return null;
  return { x: ix, y: iy };
}
