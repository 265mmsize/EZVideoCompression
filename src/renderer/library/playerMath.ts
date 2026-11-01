/**
 * 라이브러리 플레이어의 계산 로직 (순수 함수, DOM 비의존).
 * 구간 반복, 재생 속도, 확대·이동, 키보드 동작, 자막 싱크, 책갈피, 이어보기 규칙을 한곳에 둔다.
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
  /** 확대된 내용의 왼쪽 위 좌표 (요소 기준 픽셀). 항상 0 이하 */
  tx: number;
  ty: number;
}

export const FIT_VIEW: View = { scale: 1, tx: 0, ty: 0 };

/** 내용이 요소를 항상 덮도록 이동 범위를 제한한다 */
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

/** 커서 위치를 고정한 채 배율을 바꾼다 (확대·축소) */
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
export const VOLUME_STEP = 0.05;
export const SUB_SYNC_STEP_SEC = 0.5;

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
  | { type: 'rotate'; deltaDeg: 90 | -90 }
  | { type: 'flipH' }
  | { type: 'flipV' }
  | { type: 'volume'; delta: number }
  | { type: 'mute' }
  | { type: 'zoom'; dir: 1 | -1 }
  | { type: 'zoomReset' }
  | { type: 'subSync'; deltaSec: number }
  | { type: 'subReset' }
  | { type: 'subSwitch'; dir: 1 | -1 }
  | { type: 'bookmark' }
  | { type: 'bookmarkStep'; dir: 1 | -1 }
  | { type: 'step'; dir: 1 | -1 }
  | { type: 'screenshot' }
  | { type: 'picker' }
  | { type: 'keyframe'; dir: 1 | -1 }
  | { type: 'alwaysOnTop' };

/**
 * 키 입력을 플레이어 동작으로 바꾼다. 해당 없는 키는 null (브라우저 기본 동작을 막지 않는다).
 *
 * Space/K 재생·정지, ←/→ 3초(Shift 10초, Alt 1분), Ctrl+←/→ 한 프레임, Z/X/C 배속,
 * [ ] A/B 지점, \ 구간 해제, L 구간 반복, Home 처음, R·E 90도 회전, Q 반대 90도, H/V 반전,
 * ↑/↓ 볼륨, M 음소거, + - 확대(0 원래 크기), , . 자막 싱크 0.5초, / 싱크 초기화, J/Shift+J 자막 바꾸기,
 * B 책갈피 추가, Shift+PgUp/PgDn 책갈피 이동, PgUp/PgDn 이전·다음 항목, Ctrl+P 스크린샷, I 컬러 피커,
 * Ctrl+Shift+←/→ 이전·다음 키프레임, Ctrl+T 창 항상 위.
 */
export function playerAction(
  key: string,
  shift: boolean,
  ctrl: boolean,
  alt = false,
): PlayerAction | null {
  if (ctrl) {
    if (key === 'ArrowLeft')
      return shift ? { type: 'keyframe', dir: -1 } : { type: 'frame', dir: -1 };
    if (key === 'ArrowRight')
      return shift ? { type: 'keyframe', dir: 1 } : { type: 'frame', dir: 1 };
    if (key === 'p' || key === 'P') return { type: 'screenshot' };
    if (key === 't' || key === 'T') return { type: 'alwaysOnTop' };
    return null;
  }
  if (alt) {
    if (key === 'ArrowLeft') return { type: 'seek', deltaSec: -60 };
    if (key === 'ArrowRight') return { type: 'seek', deltaSec: 60 };
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
    case 'ArrowUp':
      return { type: 'volume', delta: VOLUME_STEP };
    case 'ArrowDown':
      return { type: 'volume', delta: -VOLUME_STEP };
    case 'PageUp':
      return shift ? { type: 'bookmarkStep', dir: -1 } : { type: 'step', dir: -1 };
    case 'PageDown':
      return shift ? { type: 'bookmarkStep', dir: 1 } : { type: 'step', dir: 1 };
    case ',':
      return { type: 'subSync', deltaSec: -SUB_SYNC_STEP_SEC };
    case '.':
      return { type: 'subSync', deltaSec: SUB_SYNC_STEP_SEC };
    case '/':
      return { type: 'subReset' };
    case 'j':
      return { type: 'subSwitch', dir: shift ? -1 : 1 };
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
    case 'e':
      return { type: 'rotate', deltaDeg: 90 };
    case 'q':
      return { type: 'rotate', deltaDeg: -90 };
    case 'h':
      return { type: 'flipH' };
    case 'v':
      return { type: 'flipV' };
    case 'm':
      return { type: 'mute' };
    case '+':
    case '=':
      return { type: 'zoom', dir: 1 };
    case '-':
      return { type: 'zoom', dir: -1 };
    case '0':
      return { type: 'zoomReset' };
    case 'b':
      return { type: 'bookmark' };
    case 'i':
      return { type: 'picker' };
    default:
      return null;
  }
}

/**
 * 키프레임 목록에서 현재 시각보다 뒤(dir 1) 또는 앞(dir -1)의 가장 가까운 키프레임.
 * 목록이 정렬되어 있을 필요는 없다. 없으면 null.
 */
export function nextKeyframe(times: readonly number[], t: number, dir: 1 | -1): number | null {
  const eps = 0.001;
  let best: number | null = null;
  for (const k of times) {
    if (!Number.isFinite(k)) continue;
    if (dir === 1 && k > t + eps && (best === null || k < best)) best = k;
    if (dir === -1 && k < t - eps && (best === null || k > best)) best = k;
  }
  return best;
}

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

// ----- 책갈피 (킹플레이어 B 키) -----

/** 이 간격 안에 있는 책갈피는 같은 것으로 본다 */
export const BOOKMARK_MERGE_SEC = 0.5;

/** 현재 시각에 책갈피를 더한다. 가까운 것이 있으면 넣지 않고 같은 목록을 돌려준다. */
export function addBookmark(list: readonly number[], t: number): number[] {
  if (!Number.isFinite(t) || t < 0) return [...list];
  if (list.some((b) => Math.abs(b - t) < BOOKMARK_MERGE_SEC)) return [...list];
  return [...list, Math.round(t * 100) / 100].sort((a, b) => a - b);
}

/** 현재 시각 기준 이전·다음 책갈피. 없으면 null. */
export function nextBookmark(list: readonly number[], t: number, dir: 1 | -1): number | null {
  const eps = 0.05;
  if (dir === 1) {
    for (const b of list) if (b > t + eps) return b;
    return null;
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    if (b !== undefined && b < t - eps) return b;
  }
  return null;
}

export function bookmarkStorageKey(id: string): string {
  return `vslim.bookmarks.${id}`;
}

/** 저장된 책갈피 JSON 을 읽는다. 잘못된 값은 버린다. */
export function parseBookmarks(raw: string | null): number[] {
  if (raw === null) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}
