/** 타임라인 편집 계산: 구간 잘라내기, 구간만 남기기, 트림, 스냅 */
import { describe, expect, it } from 'vitest';
import type { EditClip } from '../../src/shared/types/domain';
import { layout, clipDur } from '../../src/renderer/pages/editOps';
import {
  boundaryTimes,
  cutOut,
  keepOnly,
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
