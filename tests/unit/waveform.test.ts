/** 오디오 파형: PCM 피크 계산과 SVG 경로 */
import { describe, expect, it } from 'vitest';
import { computePeaks } from '../../src/main/services/edit/waveform';
import { MAX_WAVE_BARS, waveformPath } from '../../src/renderer/pages/waveformPath';

function pcm(values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
}

describe('피크 계산', () => {
  it('칸마다 최대 진폭을 0~100 으로 낸다 (음수도 절댓값)', () => {
    // 표본 8개, 초당 4표본, 초당 피크 2개 → 칸당 2표본
    const out = computePeaks(pcm([0, 16384, -32768, 0, 100, -100, 0, 0]), 4, 2);
    expect(out).toEqual([50, 100, 0, 0]);
  });

  it('빈 PCM 은 빈 배열, 홀수 바이트는 무시한다', () => {
    expect(computePeaks(Buffer.alloc(0), 4000, 50)).toEqual([]);
    expect(computePeaks(Buffer.from([1]), 4000, 50)).toEqual([]);
  });
});

describe('파형 경로', () => {
  it('구간 안의 피크로 위아래 대칭 선을 긋는다', () => {
    const d = waveformPath([0, 100, 50, 0], 2, 0, 2, 4, 20);
    // 2px 간격으로 두 선: 0~1초(최대 100) → 전체 높이, 1~2초(최대 50) → 절반
    expect(d).toBe('M0.0 0.0V20.0M2.0 5.0V15.0');
  });

  it('원본 구간 일부만 그린다 (클립 자르기·배속에 쓰인다)', () => {
    const d = waveformPath([0, 0, 100, 100], 1, 2, 4, 2, 10);
    expect(d).toBe('M0.0 0.0V10.0');
  });

  it('그릴 수 없으면 빈 문자열', () => {
    expect(waveformPath([], 50, 0, 1, 100, 20)).toBe('');
    expect(waveformPath([50], 50, 1, 1, 100, 20)).toBe('');
    expect(waveformPath([50], 50, 0, 1, 0, 20)).toBe('');
  });

  it('아주 넓어도 선 개수를 제한한다', () => {
    const d = waveformPath(new Array(1000).fill(30), 50, 0, 20, 100_000, 20);
    expect(d.split('M').length - 1).toBeLessThanOrEqual(MAX_WAVE_BARS + 1);
  });
});
