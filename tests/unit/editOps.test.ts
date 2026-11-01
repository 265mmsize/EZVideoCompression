/**
 * 편집기 순수 계산: N등분, 챕터 텍스트, 시간 형식
 */
import { describe, expect, it } from 'vitest';
import {
  chapterLines,
  formatChapterTime,
  layout,
  splitByInterval,
  splitEqually,
} from '../../src/renderer/pages/editOps';
import type { EditClip } from '../../src/shared/types/domain';

function clip(over: Partial<EditClip> = {}): EditClip {
  return {
    id: 'a',
    path: '/v/a.mp4',
    fileName: '여행 1.mp4',
    sourceDurationSec: 10,
    sourceWidth: 1280,
    sourceHeight: 720,
    hasAudio: true,
    inSec: 0,
    outSec: 9,
    speed: 1,
    volume: 1,
    mute: false,
    rotate: 0,
    flipH: false,
    flipV: false,
    filters: { brightness: 0, contrast: 1, saturation: 1, sharpen: 0, denoise: 0 },
    stabilize: false,
    transition: { type: 'fade', durationSec: 1 },
    texts: [
      {
        id: 't',
        text: '제목',
        x: 'center',
        y: 'bottom',
        fontSize: 40,
        color: '#ffffff',
        boxed: true,
        startSec: 0,
        endSec: null,
      },
    ],
    ...over,
  };
}

let n = 0;
const newId = (): string => `new-${String(++n)}`;

describe('N등분', () => {
  it('구간을 같은 길이 조각으로 나누고, 첫 조각만 id·텍스트, 마지막 조각만 전환을 받는다', () => {
    const parts = splitEqually(clip({ inSec: 2, outSec: 8 }), 3, newId);
    expect(parts.map((p) => [p.inSec, p.outSec])).toEqual([
      [2, 4],
      [4, 6],
      [6, 8],
    ]);
    expect(parts[0]?.id).toBe('a');
    expect(parts[1]?.id).toBe('new-1');
    expect(parts[0]?.texts).toHaveLength(1);
    expect(parts[1]?.texts).toHaveLength(0);
    expect(parts[0]?.transition.type).toBe('none');
    expect(parts[2]?.transition.type).toBe('fade');
  });

  it('너무 짧거나 범위를 벗어난 n 은 원래 클립 하나를 돌려준다', () => {
    const c = clip({ inSec: 0, outSec: 0.5 });
    expect(splitEqually(c, 3, newId)).toEqual([c]);
    expect(splitEqually(clip(), 1, newId)).toHaveLength(1);
    expect(splitEqually(clip(), 11, newId)).toHaveLength(1);
    expect(splitEqually(clip(), Number.NaN, newId)).toHaveLength(1);
  });
});

describe('챕터 텍스트', () => {
  it('시간 형식은 분·시간 단위를 자동으로 고른다', () => {
    expect(formatChapterTime(0)).toBe('0:00');
    expect(formatChapterTime(65.9)).toBe('1:05');
    expect(formatChapterTime(3725)).toBe('1:02:05');
  });

  it('클립 시작 시각마다 챕터 한 줄을 만든다 (전환 겹침 반영, 확장자 제외)', () => {
    const a = clip({ outSec: 10, transition: { type: 'fade', durationSec: 2 } }); // 10초
    const b = clip({
      id: 'b',
      fileName: '바다.mov',
      outSec: 5,
      transition: { type: 'none', durationSec: 1 },
    });
    expect(layout([a, b]).starts).toEqual([0, 8]);
    expect(chapterLines([a, b])).toEqual(['0:00 여행 1', '0:08 바다']);
  });
});

describe('시간 간격 나누기', () => {
  it('간격대로 나누고 마지막 조각은 남은 길이만큼 남는다', () => {
    const c = clip({ inSec: 0, outSec: 10 });
    const parts = splitByInterval(c, 4, newId);
    expect(parts.map((p) => [p.inSec, p.outSec])).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
  });

  it('마지막 조각이 너무 짧으면 앞 조각에 붙인다', () => {
    const parts = splitByInterval(clip({ inSec: 0, outSec: 10.1 }), 5, newId);
    expect(parts.map((p) => [p.inSec, p.outSec])).toEqual([
      [0, 5],
      [5, 10.1],
    ]);
  });

  it('간격이 너무 작거나 조각이 50개를 넘으면 원래 클립을 돌려준다', () => {
    const c = clip({ inSec: 0, outSec: 100 });
    expect(splitByInterval(c, 0.1, newId)).toEqual([c]);
    expect(splitByInterval(c, 1, newId)).toEqual([c]);
    expect(splitByInterval(c, Number.NaN, newId)).toEqual([c]);
  });

  it('간격 나누기도 텍스트는 첫 조각에, 전환은 마지막 조각에 남긴다', () => {
    const parts = splitByInterval(clip({ inSec: 0, outSec: 9 }), 3, newId);
    expect(parts).toHaveLength(3);
    expect(parts[0]?.texts).toHaveLength(1);
    expect(parts[1]?.texts).toHaveLength(0);
    expect(parts[2]?.transition.type).toBe('fade');
  });
});
