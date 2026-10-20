import { describe, expect, it } from 'vitest';
import {
  candidateCrfs,
  judge,
  parseSsimAll,
  planSegments,
  summarizeCandidate,
  SSIM_THRESHOLD,
} from '../../src/main/services/SampleEncodeService';

describe('샘플 구간 계획', () => {
  it('긴 영상은 겹치지 않는 4개 구간을 범위 안에 둔다', () => {
    const segs = planSegments(60);
    expect(segs).toHaveLength(4);
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]!;
      expect(s.startSec).toBeGreaterThanOrEqual(0);
      expect(s.startSec + s.durationSec).toBeLessThanOrEqual(60 + 1e-6);
      if (i > 0)
        expect(s.startSec).toBeGreaterThanOrEqual(segs[i - 1]!.startSec + segs[i - 1]!.durationSec);
    }
  });

  it('짧은 영상은 전체를 하나의 구간으로 본다', () => {
    expect(planSegments(4)).toEqual([{ startSec: 0, durationSec: 4 }]);
  });

  it('길이가 없으면 구간을 만들지 않는다', () => {
    expect(planSegments(0)).toEqual([]);
  });
});

describe('CRF 후보', () => {
  it('기본값 ±3 을 오름차순으로 만들고 범위(10~40)를 지킨다', () => {
    expect(candidateCrfs(21)).toEqual([18, 21, 24]);
    expect(candidateCrfs(10)).toEqual([10, 13]);
    expect(candidateCrfs(39)).toEqual([36, 39, 40]);
  });
});

describe('SSIM 파싱', () => {
  it('ffmpeg ssim 요약 줄에서 All 값을 읽는다', () => {
    const line = 'SSIM Y:0.981234 (17.2) U:0.990000 (20.0) V:0.985000 (19.0) All:0.983 (17.8)';
    expect(parseSsimAll(line)).toBeCloseTo(0.983);
  });

  it('값이 없거나 범위를 벗어나면 null 이다 (추측하지 않는다)', () => {
    expect(parseSsimAll('no summary here')).toBeNull();
    expect(parseSsimAll('All:1.5')).toBeNull();
  });
});

describe('추천 판정', () => {
  const mk = (crf: number, minSsim: number) =>
    summarizeCandidate(
      crf,
      [
        { startSec: 0, durationSec: 3, bytes: 1000 * crf, ssim: minSsim },
        { startSec: 10, durationSec: 3, bytes: 1000 * crf, ssim: minSsim + 0.005 },
      ],
      60,
    );

  it('기준을 넘는 후보 중 가장 작은 용량(큰 CRF)을 추천한다', () => {
    const cands = [mk(18, 0.995), mk(21, 0.98), mk(24, 0.96)];
    expect(judge(cands)).toEqual({ recommendedCrf: 21, verdict: 'met' });
  });

  it('기준을 넘는 후보가 없으면 가장 높은 화질을 notMet 으로 추천한다', () => {
    const cands = [mk(18, 0.93), mk(21, 0.9)];
    expect(judge(cands)).toEqual({ recommendedCrf: 18, verdict: 'notMet' });
  });

  it('판정 기준은 구간별 최솟값에 적용된다', () => {
    const c = summarizeCandidate(
      21,
      [
        { startSec: 0, durationSec: 3, bytes: 100, ssim: 0.99 },
        { startSec: 10, durationSec: 3, bytes: 100, ssim: 0.95 },
      ],
      60,
    );
    expect(c.minSsim).toBe(0.95);
    expect(c.minSsim < SSIM_THRESHOLD).toBe(true);
  });

  it('용량 추정 범위는 구간 비트레이트의 최소·최대로 계산한다', () => {
    const c = summarizeCandidate(
      21,
      [
        { startSec: 0, durationSec: 2, bytes: 1000, ssim: 0.99 },
        { startSec: 5, durationSec: 2, bytes: 3000, ssim: 0.99 },
      ],
      100,
    );
    expect(c.estVideoBytesMin).toBe(Math.round((((1000 * 8) / 2) * 100) / 8));
    expect(c.estVideoBytesMax).toBe(Math.round((((3000 * 8) / 2) * 100) / 8));
  });
});
