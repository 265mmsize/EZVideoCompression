/**
 * 타임라인 편집의 순수 계산: 구간 잘라내기(잔물결), 구간만 남기기, 클립 가장자리 트림, 스냅.
 * 화면과 테스트가 같은 규칙을 쓴다. 모든 결과는 새 배열·새 객체를 돌려주고 입력은 바꾸지 않는다.
 */
import type { EditClip } from '../../shared/types/domain';
import { clipDur, layout, MIN_PIECE_SEC } from './editOps';

/** 이보다 짧은 구간 선택은 무시한다 */
export const MIN_RANGE_SEC = 0.05;
const EPS = 0.001;
const NO_TRANSITION = { type: 'none', durationSec: 1 } as const;

export interface TimeRange {
  startSec: number;
  endSec: number;
}

/** 두 지점을 타임라인 안의 구간으로 바꾼다. 너무 짧으면 null. */
export function normalizeRange(a: number, b: number, total: number): TimeRange | null {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(total, Math.max(a, b));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < MIN_RANGE_SEC) return null;
  return { startSec: lo, endSec: hi };
}

/**
 * 타임라인 구간 [a, b) 을 잘라 없앤다. 잘린 뒤의 클립은 앞으로 당겨진다(잔물결).
 * 구간이 걸친 클립은 앞·뒤 조각으로 나뉜다. 앞 조각은 원래 id 와 텍스트, 뒤 조각은 새 id 를 받는다.
 * 잘린 지점의 전환은 없앤다.
 */
export function cutOut(clips: EditClip[], range: TimeRange, newId: () => string): EditClip[] {
  const { starts } = layout(clips);
  const out: EditClip[] = [];
  const a = range.startSec;
  const b = range.endSec;
  clips.forEach((c, i) => {
    const s = starts[i] ?? 0;
    const e = s + clipDur(c);
    // 겹치지 않으면 그대로
    if (b <= s + EPS || a >= e - EPS) {
      out.push(c);
      return;
    }
    const hasHead = a > s + EPS;
    const hasTail = e > b + EPS;
    const pieces: EditClip[] = [];
    if (hasHead) {
      pieces.push({
        ...c,
        outSec: c.inSec + (a - s) * c.speed,
        transition: { ...NO_TRANSITION },
      });
    }
    if (hasTail) {
      const tailInSec = c.inSec + (Math.max(b, s) - s) * c.speed;
      const tail: EditClip = {
        ...c,
        id: hasHead ? newId() : c.id,
        inSec: tailInSec,
        texts: hasHead ? [] : c.texts,
      };
      pieces.push(tail);
    }
    for (const p of pieces) {
      if (clipDur(p) >= MIN_PIECE_SEC * 0.25) out.push(p);
    }
  });
  return out;
}

/** 구간 밖을 모두 잘라 구간만 남긴다 */
export function keepOnly(clips: EditClip[], range: TimeRange, newId: () => string): EditClip[] {
  const { total } = layout(clips);
  const tail = cutOut(clips, { startSec: range.endSec, endSec: total + 1 }, newId);
  return cutOut(tail, { startSec: 0, endSec: range.startSec }, newId);
}

export type TrimEdge = 'in' | 'out';

/**
 * 클립의 시작(in) 또는 끝(out)을 타임라인 초만큼 움직인다.
 * 원본 범위 밖이나 최소 길이를 넘지 않도록 자른다.
 */
export function trimEdge(c: EditClip, edge: TrimEdge, deltaTimelineSec: number): EditClip {
  const dSrc = deltaTimelineSec * c.speed;
  if (edge === 'in') {
    const max = c.outSec - MIN_PIECE_SEC * c.speed;
    return { ...c, inSec: clamp(c.inSec + dSrc, 0, Math.max(0, max)) };
  }
  const min = c.inSec + MIN_PIECE_SEC * c.speed;
  return { ...c, outSec: clamp(c.outSec + dSrc, min, c.sourceDurationSec) };
}

/** 가까운 기준점(클립 경계, 재생 헤드)에 붙인다. 허용 거리 밖이면 그대로. */
export function snapTime(t: number, points: readonly number[], tolSec: number): number {
  let best = t;
  let bestD = tolSec;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d <= bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

/** 재생 헤드를 한 칸 움직인다 (0 과 전체 길이 사이) */
export function moveTime(t: number, total: number, delta: number): number {
  return clamp(t + delta, 0, Math.max(0, total));
}

/** 클립 경계 시각들 (스냅 기준점). 전체 길이 끝도 포함한다. */
export function boundaryTimes(clips: EditClip[]): number[] {
  const { starts, total } = layout(clips);
  return [...starts, total];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
