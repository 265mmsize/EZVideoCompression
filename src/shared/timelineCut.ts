/**
 * 타임라인 자르기·구간 계산 (순수 함수). 편집 화면과 내보내기(메인 프로세스)가 같은 규칙을 쓴다.
 */
import { sliceKeyframes, sliceMotion, trackClipDur, trackSpeed } from './keyframes';
import { clipDuration } from './clipTime';
import type { AnimProp, EditAnim, EditClip, EditTrack, EditTrackClip } from './types/domain';

export const MIN_PIECE_SEC = 0.2;

const EPS = 0.001;
const NO_TRANSITION = { type: 'none', durationSec: 1 } as const;
/** 타임라인 안의 구간 (초) */
export interface TimeRange {
  startSec: number;
  endSec: number;
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
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
export const ANIM_KEYS: readonly AnimProp[] = ['x', 'y', 'scale', 'opacity', 'volume'];
export function mapAnim(a: EditAnim, fn: (k: EditAnim[AnimProp]) => EditAnim[AnimProp]): EditAnim {
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
/** 클립의 결과 길이 (속도 적용 후) */
export function clipDur(c: EditClip): number {
  return clipDuration(c);
}
/** 다음 클립과 겹치는 전환 길이 (양쪽 길이의 절반 이하) */
export function transitionSec(prev: EditClip, next: EditClip | undefined): number {
  if (!next || prev.transition.type === 'none') return 0;
  return Math.max(
    0,
    Math.min(prev.transition.durationSec, Math.min(clipDur(prev), clipDur(next)) * 0.5),
  );
}
/** 각 클립의 타임라인 시작 시각과 전체 길이 */
export function layout(clips: EditClip[]): { starts: number[]; total: number } {
  const starts: number[] = [];
  let t = 0;
  clips.forEach((c, i) => {
    starts.push(t);
    t += clipDur(c) - transitionSec(c, clips[i + 1]);
  });
  return { starts, total: Math.max(0, t) };
}
