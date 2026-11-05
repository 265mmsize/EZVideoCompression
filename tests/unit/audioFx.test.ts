/** 재생 음향·화면 효과 계산: 밴드 값 범위, 저장값 검증, 화면 효과 필터 */
import { describe, expect, it } from 'vitest';
import {
  bandParams,
  clampGain,
  EQ_BANDS,
  EQ_FREQS,
  EQ_LIMIT_DB,
  EQ_PRESETS,
  fxFilter,
  FX_NAMES,
  sanitizeEq,
  sanitizeFx,
} from '../../src/renderer/library/audioFx';

describe('이퀄라이저', () => {
  it('밴드 10개, 프리셋 모두 10개, 값은 범위 안', () => {
    expect(EQ_BANDS).toBe(10);
    expect(EQ_FREQS[0]).toBe(31);
    expect(EQ_FREQS[9]).toBe(16000);
    for (const preset of Object.values(EQ_PRESETS)) {
      expect(preset).toHaveLength(10);
      for (const v of preset) expect(Math.abs(v)).toBeLessThanOrEqual(EQ_LIMIT_DB);
    }
  });

  it('밴드 값은 ±12dB 로 자르고 0.5dB 단위로 맞춘다', () => {
    expect(clampGain(20)).toBe(12);
    expect(clampGain(-20)).toBe(-12);
    expect(clampGain(1.3)).toBe(1.5);
    expect(clampGain(Number.NaN)).toBe(0);
  });

  it('저장된 값이 모양에 맞지 않으면 평탄으로 돌아간다', () => {
    expect(sanitizeEq('나쁜 값')).toEqual(EQ_PRESETS['평탄']);
    expect(sanitizeEq([1, 2])).toEqual(EQ_PRESETS['평탄']);
    expect(sanitizeEq([99, 'x', ...new Array<number>(8).fill(0)])).toEqual([
      12,
      0,
      ...new Array<number>(8).fill(0),
    ]);
  });

  it('피킹 필터 매개변수는 밴드 주파수와 값을 그대로 쓰고 값은 범위 안', () => {
    expect(bandParams(1000, 30)).toEqual({ type: 'peaking', frequency: 1000, gain: 12, Q: 1.1 });
  });
});

describe('화면 효과', () => {
  it('모든 효과는 CSS 필터 문자열을 가진다 (없음은 none)', () => {
    expect(fxFilter('none')).toBe('none');
    for (const name of FX_NAMES) expect(typeof fxFilter(name)).toBe('string');
    expect(fxFilter('grayscale')).toBe('grayscale(1)');
  });

  it('저장된 화면 효과 설정이 잘못되면 기본값', () => {
    expect(sanitizeFx(null)).toEqual({ preset: 'none', vignette: false, scanlines: false });
    expect(sanitizeFx({ preset: '없는효과', vignette: 1 })).toEqual({
      preset: 'none',
      vignette: false,
      scanlines: false,
    });
    expect(sanitizeFx({ preset: 'sepia', vignette: true, scanlines: true })).toEqual({
      preset: 'sepia',
      vignette: true,
      scanlines: true,
    });
  });
});
