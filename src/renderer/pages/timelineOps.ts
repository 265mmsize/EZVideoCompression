/**
 * 타임라인 편집의 순수 계산: 구간 잘라내기(잔물결), 구간만 남기기, 클립 가장자리 트림, 스냅.
 * 화면과 테스트가 같은 규칙을 쓴다. 모든 결과는 새 배열·새 객체를 돌려주고 입력은 바꾸지 않는다.
 */
import { sliceKeyframes, sliceMotion, trackClipDur, trackSpeed } from '../../shared/keyframes';
import type {
  AnimProp,
  EditAnim,
  EditClip,
  EditTrack,
  EditTrackClip,
} from '../../shared/types/domain';
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
        motion: sliceMotion(c.motion, 0, a - s),
      });
    }
    if (hasTail) {
      const skip = Math.max(b, s) - s;
      const tailInSec = c.inSec + skip * c.speed;
      const tail: EditClip = {
        ...c,
        id: hasHead ? newId() : c.id,
        inSec: tailInSec,
        texts: hasHead ? [] : c.texts,
        motion: sliceMotion(c.motion, skip, e - s),
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
    const inSec = clamp(c.inSec + dSrc, 0, Math.max(0, max));
    const moved = (inSec - c.inSec) / c.speed;
    return { ...c, inSec, motion: sliceMotion(c.motion, moved, Infinity) };
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

// ----- 추가 트랙 -----

const ANIM_KEYS: readonly AnimProp[] = ['x', 'y', 'scale', 'opacity', 'volume'];

function mapAnim(a: EditAnim, fn: (k: EditAnim[AnimProp]) => EditAnim[AnimProp]): EditAnim {
  const out = { ...a };
  for (const key of ANIM_KEYS) out[key] = fn(a[key]);
  return out;
}

/**
 * 추가 트랙에도 구간 잘라내기를 적용한다 (모든 트랙을 함께 당긴다).
 * 구간 뒤의 클립은 구간 길이만큼 앞으로 오고, 걸친 클립은 앞·뒤 조각으로 나뉜다. 키프레임도 조각을 따라간다.
 */
export function cutOutTracks(
  tracks: EditTrack[],
  range: TimeRange,
  newId: () => string,
): EditTrack[] {
  const a = range.startSec;
  const b = range.endSec;
  const len = b - a;
  return tracks.map((track) => ({
    ...track,
    clips: track.clips.flatMap((c): EditTrackClip[] => {
      const s = c.startSec;
      const d = trackClipDur(c);
      const e = s + d;
      if (e <= a + EPS) return [c];
      if (s >= b - EPS) return [{ ...c, startSec: Math.max(0, s - len) }];
      const out: EditTrackClip[] = [];
      const hasHead = s < a - EPS;
      const hasTail = e > b + EPS;
      const sp = trackSpeed(c);
      if (hasHead) {
        const keep = a - s;
        out.push({
          ...c,
          outSec: c.inSec + keep * sp,
          anim: mapAnim(c.anim, (k) => sliceKeyframes(k, 0, keep)),
        });
      }
      if (hasTail) {
        const skip = Math.max(b, s) - s;
        out.push({
          ...c,
          id: hasHead ? newId() : c.id,
          // 구간이 잘린 뒤에는 뒤 조각이 구간 시작 자리에서 이어진다
          startSec: Math.max(0, a),
          inSec: c.inSec + skip * sp,
          anim: mapAnim(c.anim, (k) => sliceKeyframes(k, skip, d)),
        });
      }
      return out.filter((x) => trackClipDur(x) >= MIN_PIECE_SEC * 0.25);
    }),
  }));
}

/** 추가 트랙에서 구간 밖을 잘라 구간만 남긴다 */
export function keepOnlyTracks(
  tracks: EditTrack[],
  range: TimeRange,
  newId: () => string,
): EditTrack[] {
  const tail = cutOutTracks(tracks, { startSec: range.endSec, endSec: 1e9 }, newId);
  return cutOutTracks(tail, { startSec: 0, endSec: range.startSec }, newId);
}

/** 추가 트랙 클립을 타임라인에서 옮긴다 (0 이전으로는 가지 않는다) */
export function moveTrackClip(c: EditTrackClip, startSec: number): EditTrackClip {
  return { ...c, startSec: Math.max(0, startSec) };
}

/**
 * 추가 트랙 클립의 가장자리 조절. 시작(in)을 움직이면 화면 위치도 같이 움직여 뒤쪽 끝이 제자리에 남고,
 * 키프레임은 클립 안 시간에 맞춰 당기거나 민다.
 */
export function trimTrackClip(c: EditTrackClip, edge: TrimEdge, delta: number): EditTrackClip {
  const sp = trackSpeed(c);
  if (edge === 'out') {
    const outSec = clamp(c.outSec + delta * sp, c.inSec + MIN_PIECE_SEC * sp, c.sourceDurationSec);
    return { ...c, outSec };
  }
  // 시작은 원본 0 과 타임라인 0 을 넘지 않고, 최소 길이를 남긴다 (d 는 타임라인 초)
  const lo = Math.max(-c.inSec / sp, -c.startSec);
  const hi = trackClipDur(c) - MIN_PIECE_SEC;
  const d = clamp(delta, lo, Math.max(lo, hi));
  return {
    ...c,
    inSec: c.inSec + d * sp,
    startSec: c.startSec + d,
    anim: mapAnim(c.anim, (k) => sliceKeyframes(k, d, Infinity)),
  };
}

/** 추가 트랙 클립 경계 (스냅 기준점) */
export function trackBoundaryTimes(tracks: EditTrack[]): number[] {
  const out: number[] = [];
  for (const t of tracks)
    for (const c of t.clips) out.push(c.startSec, c.startSec + trackClipDur(c));
  return out;
}

/** 클립을 같은 종류의 다른 트랙으로 옮긴다. 종류가 다르거나 찾지 못하면 그대로 돌려준다 */
export function moveClipToTrack(
  tracks: EditTrack[],
  fromId: string,
  toId: string,
  clipId: string,
): EditTrack[] {
  const from = tracks.find((t) => t.id === fromId);
  const to = tracks.find((t) => t.id === toId);
  const clip = from?.clips.find((c) => c.id === clipId);
  if (!from || !to || !clip || from.id === to.id || from.kind !== to.kind) return tracks;
  return tracks.map((t) => {
    if (t.id === from.id) return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
    if (t.id === to.id) return { ...t, clips: [...t.clips, clip] };
    return t;
  });
}
