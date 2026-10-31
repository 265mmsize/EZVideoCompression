/**
 * 실행 취소 스택 (순수 함수).
 *
 * 같은 대상을 연속으로 조절하는 변경(슬라이더 드래그 등)은 key 가 같고 짧은 간격이면 한 단계로 묶는다.
 * key 가 null 인 변경(추가·분할·삭제 등)은 항상 따로 한 단계가 된다.
 */
export interface History<T> {
  past: T[];
  future: T[];
  /** 마지막으로 스냅샷을 남긴 시각 (ms) */
  lastAt: number;
  /** 마지막 단계의 묶음 키 */
  lastKey: string | null;
}

export const MAX_HISTORY = 100;
/** 같은 키의 연속 변경을 묶는 최대 간격 */
export const COALESCE_MS = 700;

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [], lastAt: 0, lastKey: null };
}

/**
 * 변경 직전 상태(before)를 기록한다. 같은 키의 직전 변경과 간격이 짧으면 새 단계를 만들지 않는다.
 * 새 변경이 생기면 다시 실행 목록은 비운다.
 */
export function recordChange<T>(
  h: History<T>,
  before: T,
  now: number,
  key: string | null,
): History<T> {
  const coalesce =
    key !== null && h.past.length > 0 && h.lastKey === key && now - h.lastAt < COALESCE_MS;
  if (coalesce) return { ...h, future: [], lastAt: now };
  const past = [...h.past, before].slice(-MAX_HISTORY);
  return { past, future: [], lastAt: now, lastKey: key };
}

/** 실행 취소: 현재 상태를 다시 실행 목록에 넣고 이전 상태를 돌려준다 */
export function undo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  const prev = h.past[h.past.length - 1];
  if (prev === undefined) return null;
  return {
    history: {
      past: h.past.slice(0, -1),
      future: [current, ...h.future],
      lastAt: 0,
      lastKey: null,
    },
    state: prev,
  };
}

/** 다시 실행 */
export function redo<T>(h: History<T>, current: T): { history: History<T>; state: T } | null {
  const next = h.future[0];
  if (next === undefined) return null;
  return {
    history: { past: [...h.past, current], future: h.future.slice(1), lastAt: 0, lastKey: null },
    state: next,
  };
}
