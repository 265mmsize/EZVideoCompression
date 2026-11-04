/**
 * 파형 피크(0~100) → SVG 경로 (순수 함수). 원본 시간 구간 [fromSec, toSec] 을 주어진 너비에 그린다.
 * 가로 픽셀 칸마다 그 구간의 최대 피크로 위아래 대칭 선을 긋는다.
 */

/** 그릴 세로 선의 최대 개수 (아주 넓은 클립에서도 경로가 커지지 않게) */
export const MAX_WAVE_BARS = 1500;

export function waveformPath(
  peaks: readonly number[],
  peaksPerSec: number,
  fromSec: number,
  toSec: number,
  width: number,
  height: number,
): string {
  if (
    peaks.length === 0 ||
    !(width > 0) ||
    !(height > 0) ||
    !(toSec > fromSec) ||
    !(peaksPerSec > 0)
  )
    return '';
  const step = Math.max(2, width / MAX_WAVE_BARS);
  const mid = height / 2;
  const span = toSec - fromSec;
  const parts: string[] = [];
  for (let x = 0; x < width; x += step) {
    const t0 = fromSec + (x / width) * span;
    const t1 = fromSec + (Math.min(width, x + step) / width) * span;
    const i0 = Math.max(0, Math.floor(t0 * peaksPerSec));
    const i1 = Math.max(i0 + 1, Math.ceil(t1 * peaksPerSec));
    let peak = 0;
    for (let i = i0; i < i1 && i < peaks.length; i++) peak = Math.max(peak, peaks[i] ?? 0);
    const h = Math.max(0.5, (peak / 100) * mid);
    parts.push(`M${x.toFixed(1)} ${(mid - h).toFixed(1)}V${(mid + h).toFixed(1)}`);
  }
  return parts.join('');
}
