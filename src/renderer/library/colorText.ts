/** 컬러 피커 결과 문구 (순수 함수) */
import { rgbToHex, rgbToHsl, rgbToHsv } from './colorMath';

export function colorPickerText(c: { r: number; g: number; b: number }): string {
  const hsl = rgbToHsl(c);
  const hsv = rgbToHsv(c);
  return [
    `HEX  ${rgbToHex(c)}`,
    `RGB  ${String(c.r)}, ${String(c.g)}, ${String(c.b)}`,
    `HSL  ${String(hsl.h)}°, ${String(hsl.s)}%, ${String(hsl.l)}%`,
    `HSV  ${String(hsv.h)}°, ${String(hsv.s)}%, ${String(hsv.v)}%`,
  ].join('\n');
}
