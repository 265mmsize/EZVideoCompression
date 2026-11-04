/** 타임라인 편집 계산: 구간 잘라내기, 구간만 남기기, 트림, 스냅 */
import { describe, expect, it } from 'vitest';
import type { EditClip, EditTrack, EditTrackClip } from '../../src/shared/types/domain';
import { layout, clipDur } from '../../src/renderer/pages/editOps';
import {
  boundaryTimes,
  cutOut,
  cutOutTracks,
  keepOnly,
  keepOnlyTracks,
  moveTrackClip,
  trackBoundaryTimes,
  trimTrackClip,
  moveTime,
  normalizeRange,
  snapTime,
  trimEdge,
} from '../../src/renderer/pages/timelineOps';

let seq = 0;
const newId = (): string => `n${String(++seq)}`;

function clip(id: string, inSec: number, outSec: number, extra: Partial<EditClip> = {}): EditClip {
  return {
    id,
    path: `/v/${id}.mp4`,
    fileName: `${id}.mp4`,
    sourceDurationSec: 100,
    sourceWidth: 1280,
    sourceHeight: 720,
    hasAudio: true,
    inSec,
    outSec,
    speed: 1,
    stabilize: false,
    rotate: 0,
    flipH: false,
    flipV: false,
    filters: { brightness: 0, contrast: 1, saturation: 1, sharpen: 0, denoise: 0 },
    transition: { type: 'none', durationSec: 1 },
    texts: [],
    ...extra,
  } as EditClip;
}

/** 타임라인 시작 시각과 길이를 한 번에 본다 */
function timeline(clips: EditClip[]): { starts: number[]; total: number } {
  return layout(clips);
}

describe('구간 선택', () => {
  it('두 지점을 정렬하고 전체 길이 안으로 자른다', () => {
    expect(normalizeRange(5, 2, 10)).toEqual({ startSec: 2, endSec: 5 });
    expect(normalizeRange(-3, 4, 10)).toEqual({ startSec: 0, endSec: 4 });
    expect(normalizeRange(8, 20, 10)).toEqual({ startSec: 8, endSec: 10 });
  });

  it('너무 짧은 구간은 null', () => {
    expect(normalizeRange(1, 1.01, 10)).toBeNull();
    expect(normalizeRange(Number.NaN, 2, 10)).toBeNull();
  });
});

describe('구간 잘라내기 (잔물결)', () => {
  it('클립 하나의 가운데를 자르면 앞·뒤 조각이 되고 뒤 조각은 이어진다', () => {
    const clips = [clip('a', 0, 10)];
    const out = cutOut(clips, { startSec: 3, endSec: 5 }, newId);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'a', inSec: 0, outSec: 3 });
    expect(out[1]).toMatchObject({ inSec: 5, outSec: 10 });
    expect(out[1]?.id).not.toBe('a');
    expect(timeline(out).total).toBeCloseTo(8, 6);
  });

  it('잘린 지점의 앞 조각은 전환을 잃는다', () => {
    const clips = [clip('a', 0, 10, { transition: { type: 'fade', durationSec: 1 } })];
    const out = cutOut(clips, { startSec: 3, endSec: 5 }, newId);
    expect(out[0]?.transition.type).toBe('none');
    expect(out[1]?.transition.type).toBe('fade');
  });

  it('여러 클립에 걸친 구간은 가운데 클립을 없애고 가장자리는 자른다', () => {
    const clips = [clip('a', 0, 4), clip('b', 0, 4), clip('c', 0, 4)];
    const out = cutOut(clips, { startSec: 2, endSec: 10 }, newId);
    // a 는 앞 2초, b 는 통째로 사라지고, c 는 뒤 2초(원본 2~4초)만 남는다
    expect(out.map((c) => c.id)).toEqual(['a', 'c']);
    expect(out[0]).toMatchObject({ inSec: 0, outSec: 2 });
    expect(out[1]).toMatchObject({ inSec: 2, outSec: 4 });
    expect(timeline(out).total).toBeCloseTo(4, 6);
  });

  it('배속이 있으면 자르는 지점을 원본 시간으로 환산한다', () => {
    const clips = [clip('a', 0, 10, { speed: 2 })];
    // 결과 길이 5초, 3~4초 구간을 자르면 원본 6~8초가 빠진다
    const out = cutOut(clips, { startSec: 3, endSec: 4 }, newId);
    expect(out[0]).toMatchObject({ inSec: 0, outSec: 6 });
    expect(out[1]).toMatchObject({ inSec: 8, outSec: 10 });
    expect(timeline(out).total).toBeCloseTo(4, 6);
  });

  it('구간 밖의 클립은 그대로 남는다', () => {
    const clips = [clip('a', 0, 2), clip('b', 0, 2)];
    const out = cutOut(clips, { startSec: 5, endSec: 6 }, newId);
    expect(out).toEqual(clips);
  });

  it('입력 배열과 객체는 바뀌지 않는다', () => {
    const clips = [clip('a', 0, 10)];
    const snapshot = JSON.stringify(clips);
    cutOut(clips, { startSec: 1, endSec: 2 }, newId);
    expect(JSON.stringify(clips)).toBe(snapshot);
  });
});

describe('구간만 남기기', () => {
  it('구간 바깥을 모두 자르고 구간이 0초에서 시작하게 한다', () => {
    const clips = [clip('a', 0, 4), clip('b', 0, 4)];
    const out = keepOnly(clips, { startSec: 2, endSec: 6 }, newId);
    expect(timeline(out).total).toBeCloseTo(4, 6);
    expect(out[0]).toMatchObject({ id: 'a', inSec: 2, outSec: 4 });
  });
});

describe('클립 가장자리 트림', () => {
  it('끝을 줄이고 늘리되 원본 길이와 최소 길이를 넘지 않는다', () => {
    const c = clip('a', 10, 20);
    expect(trimEdge(c, 'out', -3).outSec).toBeCloseTo(17, 6);
    expect(trimEdge(c, 'out', 500).outSec).toBe(100);
    expect(trimEdge(c, 'out', -50).outSec).toBeGreaterThan(c.inSec);
  });

  it('시작을 움직여도 최소 길이를 지키고 0 밑으로 내려가지 않는다', () => {
    const c = clip('a', 2, 10);
    expect(trimEdge(c, 'in', -9).inSec).toBe(0);
    expect(trimEdge(c, 'in', 100).inSec).toBeLessThan(c.outSec);
    expect(clipDur(trimEdge(c, 'in', 100))).toBeGreaterThanOrEqual(0.2 - 1e-9);
  });

  it('배속을 고려해 원본 시간으로 움직인다', () => {
    const c = clip('a', 0, 10, { speed: 2 });
    expect(trimEdge(c, 'out', -1).outSec).toBeCloseTo(8, 6);
  });
});

describe('스냅과 재생 헤드', () => {
  it('허용 거리 안의 기준점에 붙이고 밖이면 그대로 둔다', () => {
    expect(snapTime(4.95, [0, 5, 10], 0.1)).toBe(5);
    expect(snapTime(4.5, [0, 5, 10], 0.1)).toBe(4.5);
  });

  it('클립 경계와 전체 길이를 기준점으로 준다', () => {
    expect(boundaryTimes([clip('a', 0, 2), clip('b', 0, 3)])).toEqual([0, 2, 5]);
  });

  it('재생 헤드는 0과 전체 길이 사이에서만 움직인다', () => {
    expect(moveTime(0.5, 10, -1)).toBe(0);
    expect(moveTime(9.5, 10, 1)).toBe(10);
    expect(moveTime(5, 10, 0.5)).toBe(5.5);
  });
});

describe('추가 트랙 편집', () => {
  function tclip(over: Partial<EditTrackClip> = {}): EditTrackClip {
    return {
      id: 't1',
      path: '/v/o.mp4',
      fileName: 'o.mp4',
      kind: 'video',
      sourceDurationSec: 100,
      sourceWidth: 640,
      sourceHeight: 360,
      hasAudio: true,
      startSec: 2,
      inSec: 10,
      outSec: 16,
      volume: 1,
      mute: false,
      x: 0.5,
      y: 0.5,
      scale: 0.4,
      opacity: 1,
      anim: {
        x: [
          { t: 1, v: 0.1 },
          { t: 5, v: 0.9 },
        ],
        y: [],
        scale: [],
        opacity: [],
        volume: [],
      },
      ...over,
    };
  }
  const track = (clips: EditTrackClip[]): EditTrack[] => [
    { id: 'tr', kind: 'video', name: '영상 1', enabled: true, clips },
  ];

  it('구간 뒤의 트랙 클립은 구간 길이만큼 당겨진다', () => {
    const out = cutOutTracks(track([tclip({ startSec: 10 })]), { startSec: 2, endSec: 5 }, newId);
    expect(out[0]?.clips[0]?.startSec).toBe(7);
  });

  it('걸친 클립은 앞·뒤 조각이 되고 키프레임이 따라간다', () => {
    // 클립은 타임라인 2~8초. 4~5초를 자르면 앞 2초(원본 10~12), 뒤 3초(원본 13~16)가 4초부터 이어진다
    const out = cutOutTracks(track([tclip()]), { startSec: 4, endSec: 5 }, newId)[0]?.clips ?? [];
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 't1', startSec: 2, inSec: 10, outSec: 12 });
    expect(out[0]?.anim.x).toEqual([{ t: 1, v: 0.1 }]);
    expect(out[1]).toMatchObject({ startSec: 4, inSec: 13, outSec: 16 });
    // 원래 5초 키프레임은 뒤 조각 안에서 2초
    expect(out[1]?.anim.x).toEqual([{ t: 2, v: 0.9 }]);
  });

  it('구간만 남기면 구간 밖 트랙 클립은 사라지고 남은 것은 0초 기준으로 옮겨진다', () => {
    const out = keepOnlyTracks(
      track([tclip(), tclip({ id: 't2', startSec: 20, inSec: 0, outSec: 2 })]),
      { startSec: 3, endSec: 6 },
      newId,
    )[0]?.clips;
    expect(out).toHaveLength(1);
    expect(out?.[0]).toMatchObject({ startSec: 0, inSec: 11, outSec: 14 });
  });

  it('시작을 줄이면 위치도 같이 움직이고 키프레임은 당겨진다, 끝은 원본 안에서만', () => {
    const t = trimTrackClip(tclip(), 'in', 2);
    expect(t).toMatchObject({ startSec: 4, inSec: 12, outSec: 16 });
    expect(t.anim.x).toEqual([{ t: 3, v: 0.9 }]);
    expect(trimTrackClip(tclip(), 'in', -50)).toMatchObject({ startSec: 0, inSec: 8 });
    expect(trimTrackClip(tclip(), 'out', 500).outSec).toBe(100);
    expect(trimTrackClip(tclip(), 'out', -50).outSec).toBeCloseTo(10.2, 6);
  });

  it('이동은 0 이전으로 가지 않고, 경계 시각을 스냅 기준점으로 준다', () => {
    expect(moveTrackClip(tclip(), -3).startSec).toBe(0);
    expect(trackBoundaryTimes(track([tclip()]))).toEqual([2, 8]);
  });
});
