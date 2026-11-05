/**
 * 타임라인 편집의 순수 계산: 구간 잘라내기(잔물결), 구간만 남기기, 클립 가장자리 트림, 스냅.
 * 화면과 테스트가 같은 규칙을 쓴다. 모든 결과는 새 배열·새 객체를 돌려주고 입력은 바꾸지 않는다.
 */
import { sliceKeyframes, sliceMotion, trackClipDur, trackSpeed } from '../../shared/keyframes';
import type { EditClip, EditTrack, EditTrackClip } from '../../shared/types/domain';
import { layout, MIN_PIECE_SEC } from './editOps';
import {
  cutOut,
  cutOutTracks,
  keepOnly,
  keepOnlyTracks,
  clamp,
  mapAnim,
  type TimeRange,
} from '../../shared/timelineCut';
export { cutOut, cutOutTracks, keepOnly, keepOnlyTracks, type TimeRange };

/** 이보다 짧은 구간 선택은 무시한다 */
export const MIN_RANGE_SEC = 0.05;

/** 두 지점을 타임라인 안의 구간으로 바꾼다. 너무 짧으면 null. */
export function normalizeRange(a: number, b: number, total: number): TimeRange | null {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(total, Math.max(a, b));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < MIN_RANGE_SEC) return null;
  return { startSec: lo, endSec: hi };
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

// ----- 추가 트랙 -----

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
