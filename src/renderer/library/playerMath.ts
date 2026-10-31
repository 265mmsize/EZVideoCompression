/**
 * 라이브러리 플레이어의 계산 로직 (순수 함수, DOM 비의존).
 * 구간 반복, 재생 속도, 확대·이동 보기의 규칙을 한곳에 둔다. 테스트에서 직접 검증한다.
 */

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export const MIN_LOOP_SEC = 0.2;
const LOOP_EPSILON = 0.05;

export interface LoopRange {
  startSec: number;
  endSec: number;
}

/**
 * A/B 구간을 정리한다. 한쪽만 찍혔거나 구간이 너무 짧으면 null.
 * 순서가 바뀌었으면 뒤집고, 영상 길이를 넘는 끝은 길이로 자른다.
 */
export function normalizeLoop(
  a: number | null,
  b: number | null,
  durationSec: number | null,
): LoopRange | null {
  if (a === null || b === null) return null;
  const max = durationSec ?? Number.POSITIVE_INFINITY;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(max, Math.max(a, b));
  if (hi - lo < MIN_LOOP_SEC) return null;
  return { startSec: lo, endSec: hi };
}

/** 재생 위치가 구간 끝에 닿았으면 되돌릴 시작 위치, 아니면 null */
export function loopBackTarget(timeSec: number, range: LoopRange | null): number | null {
  if (!range) return null;
  if (timeSec >= range.endSec - LOOP_EPSILON) return range.startSec;
  return null;
}

/** 재생 속도 단계를 한 칸 올리거나 내린다 (끝에서는 머문다) */
export function stepRate(current: number, dir: 1 | -1): PlaybackRate {
  const idx = PLAYBACK_RATES.indexOf(current as PlaybackRate);
  const base = idx >= 0 ? idx : PLAYBACK_RATES.indexOf(1);
  const next = Math.min(PLAYBACK_RATES.length - 1, Math.max(0, base + dir));
  return PLAYBACK_RATES[next] ?? 1;
}

// ----- 확대·이동 보기 -----

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;

export interface View {
  /** 1 = 맞춤, MAX_SCALE 까지 */
  scale: number;
  /** 확대된 이미지의 왼쪽 위 좌표 (요소 기준 픽셀). 항상 0 이하 */
  tx: number;
  ty: number;
}

export const FIT_VIEW: View = { scale: 1, tx: 0, ty: 0 };

/** 이미지가 요소를 항상 덮도록 이동 범위를 제한한다 */
export function clampView(view: View, width: number, height: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale));
  if (scale <= MIN_SCALE) return FIT_VIEW;
  const minTx = width - width * scale;
  const minTy = height - height * scale;
  return {
    scale,
    tx: Math.min(0, Math.max(minTx, view.tx)),
    ty: Math.min(0, Math.max(minTy, view.ty)),
  };
}

/** 커서 위치를 고정한 채 배율을 바꾼다 (휠 확대·축소) */
export function zoomAt(
  view: View,
  factor: number,
  cx: number,
  cy: number,
  width: number,
  height: number,
): View {
  const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const ratio = nextScale / view.scale;
  return clampView(
    {
      scale: nextScale,
      tx: cx - (cx - view.tx) * ratio,
      ty: cy - (cy - view.ty) * ratio,
    },
    width,
    height,
  );
}

/** 드래그 이동 */
export function panBy(view: View, dx: number, dy: number, width: number, height: number): View {
  return clampView({ ...view, tx: view.tx + dx, ty: view.ty + dy }, width, height);
}
