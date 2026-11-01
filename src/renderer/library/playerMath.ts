/**
 * 라이브러리 플레이어의 계산 로직 (순수 함수, DOM 비의존).
 * 구간 반복, 재생 속도, 확대·이동 보기의 규칙을 한곳에 둔다. 테스트에서 직접 검증한다.
 */

/** 킹플레이어 도움말 기준 0.25~4배 */
export const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
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

// ----- 키보드 동작 (킹플레이어 단축키 중 공통 기능) -----

export const FRAME_STEP_SEC = 1 / 30;

export type PlayerAction =
  | { type: 'toggle' }
  | { type: 'seek'; deltaSec: number }
  | { type: 'frame'; dir: 1 | -1 }
  | { type: 'rate'; dir: 1 | -1 }
  | { type: 'rateReset' }
  | { type: 'markA' }
  | { type: 'markB' }
  | { type: 'loop' }
  | { type: 'clearRange' }
  | { type: 'home' }
  | { type: 'rotate' }
  | { type: 'flipH' }
  | { type: 'flipV' };

/**
 * 키 입력을 플레이어 동작으로 바꾼다. 해당 없는 키는 null (브라우저 기본 동작을 막지 않는다).
 * Space/K 재생·정지, ←/→ 3초(Shift 10초), , . 프레임 이동, Z 배속 초기화, X/C 감속·가속,
 * [ ] A/B 지점, L 구간 반복, R 회전, H/V 반전.
 */
export function playerAction(key: string, shift: boolean, ctrl: boolean): PlayerAction | null {
  // Ctrl+←/→ 는 한 프레임 이동 (도움말 기준). 나머지 Ctrl 조합은 브라우저 단축키와 겹치므로 처리하지 않는다.
  if (ctrl) {
    if (key === 'ArrowLeft') return { type: 'frame', dir: -1 };
    if (key === 'ArrowRight') return { type: 'frame', dir: 1 };
    return null;
  }
  const k = key.length === 1 ? key.toLowerCase() : key;
  switch (k) {
    case 'Home':
      return { type: 'home' };
    case '\\':
      return { type: 'clearRange' };
    case ' ':
    case 'k':
      return { type: 'toggle' };
    case 'ArrowLeft':
      return { type: 'seek', deltaSec: shift ? -10 : -3 };
    case 'ArrowRight':
      return { type: 'seek', deltaSec: shift ? 10 : 3 };
    case ',':
      return { type: 'frame', dir: -1 };
    case '.':
      return { type: 'frame', dir: 1 };
    case 'z':
      return { type: 'rateReset' };
    case 'x':
      return { type: 'rate', dir: -1 };
    case 'c':
      return { type: 'rate', dir: 1 };
    case '[':
      return { type: 'markA' };
    case ']':
      return { type: 'markB' };
    case 'l':
      return { type: 'loop' };
    case 'r':
      return { type: 'rotate' };
    case 'h':
      return { type: 'flipH' };
    case 'v':
      return { type: 'flipV' };
    default:
      return null;
  }
}

// ----- 이어보기 -----

/** 저장된 위치에서 이어볼지 판정한다. 너무 처음이거나 거의 끝이면 처음부터 연다. */
export function shouldResume(savedSec: number | null, durationSec: number | null): boolean {
  if (savedSec === null || !Number.isFinite(savedSec)) return false;
  if (savedSec < 3) return false;
  if (durationSec !== null && savedSec > durationSec - 5) return false;
  return true;
}

/** 이어보기 저장 키 (브라우저 저장소, 사용자 편의 설정) */
export function resumeStorageKey(id: string): string {
  return `vslim.resume.${id}`;
}
