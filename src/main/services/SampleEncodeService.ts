/**
 * 샘플 기반 품질 추천 (3단계).
 *
 * 절차
 *  1) 영상 안에서 짧은 구간 여러 개를 고른다 (고정 위치: 10%, 35%, 60%, 85%).
 *  2) 각 구간을 무손실(FFV1) 기준본으로 만든다.
 *  3) 인코더별 CRF 후보(기본값 ±3)로 같은 구간을 인코딩하고 크기와 SSIM 을 잰다.
 *  4) SSIM 의 구간별 최솟값이 기준(0.97)을 넘는 후보 중 가장 작은 것을 추천한다.
 *     기준을 넘는 후보가 없으면 가장 높은 화질 후보를 추천하고 "기준 미달"로 표시한다.
 *
 * 한계 (화면에도 표시한다)
 *  - 샘플 구간의 평가이며 전체 영상의 품질을 검증한 것이 아니다.
 *  - VMAF 는 이 FFmpeg 빌드에 libvmaf 가 없어 사용하지 않는다. SSIM 만 사용한다.
 *  - 구간은 고정 위치다. 움직임이 많은 구간을 골라내는 기능은 아직 없다.
 *  - 예상 용량은 샘플 비트레이트에서 추정한 범위이며 확정값이 아니다.
 *
 * SSIM 은 0~1 값이다. 백분율로 바꾸어 "화질 보존 %"처럼 표현하지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { JobSettings, ProbeResult, QualityRecommendation } from '../../shared/types/domain';
import { AppError } from './AppError';
import { PRESET_SPECS, defaultCrfFor, encoderFor, outputPixFmt } from './CompressionPolicyService';
import type { FFmpegProcessService } from './FFmpegProcessService';

export const SAMPLE_SEGMENT_SEC = 3;
export const SAMPLE_POSITIONS = [0.1, 0.35, 0.6, 0.85] as const;
/** 제품 초기 실험값. 테스트 영상과 육안 평가로 조정해야 한다. */
export const SSIM_THRESHOLD = 0.97;
export const CRF_STEP = 3;
export const SAMPLE_TOTAL_TIMEOUT_MS = 120_000;
const SAMPLE_CALL_TIMEOUT_MS = 90_000;

export interface SegmentPlan {
  startSec: number;
  durationSec: number;
}

/**
 * 구간 계획. 짧은 영상은 구간이 겹치거나 범위를 넘지 않도록 줄이거나 하나로 합친다.
 */
export function planSegments(durationSec: number): SegmentPlan[] {
  if (!(durationSec > 0)) return [];
  const len = Math.min(SAMPLE_SEGMENT_SEC, durationSec);
  if (durationSec <= len * 1.5) {
    // 아주 짧은 영상: 전체를 하나의 구간으로 본다
    return [{ startSec: 0, durationSec: round2(durationSec) }];
  }
  const plans: SegmentPlan[] = [];
  let prevEnd = 0;
  for (const f of SAMPLE_POSITIONS) {
    const center = f * durationSec;
    let start = Math.min(Math.max(0, center - len / 2), durationSec - len);
    start = Math.max(start, prevEnd); // 앞 구간과 겹치지 않게 민다
    if (start + len > durationSec + 1e-6) continue; // 더 들어갈 자리가 없으면 건너뛴다
    plans.push({ startSec: round2(start), durationSec: round2(len) });
    prevEnd = start + len;
  }
  return plans;
}

/** 기본 CRF 를 중심으로 한 후보 목록 (범위 10~40, 중복 제거, 오름차순) */
export function candidateCrfs(baseCrf: number): number[] {
  const set = new Set(
    [baseCrf - CRF_STEP, baseCrf, baseCrf + CRF_STEP].map((c) => Math.min(40, Math.max(10, c))),
  );
  return [...set].sort((a, b) => a - b);
}

export function parseSsimAll(stderr: string): number | null {
  // ffmpeg ssim 요약 줄: "SSIM Y:0.99 (20.0) U:... V:... All:0.985 (19.1)"
  const matches = [...stderr.matchAll(/All:([0-9]+(?:\.[0-9]+)?)/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const v = Number(last[1]);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

export interface SegmentMeasure {
  startSec: number;
  durationSec: number;
  bytes: number;
  ssim: number;
}

/** 후보 하나의 구간 측정값을 요약하고, 전체 영상 용량 범위를 추정한다 (확정 아님). */
export function summarizeCandidate(
  crf: number,
  measures: SegmentMeasure[],
  fullDurationSec: number,
): QualityRecommendation['candidates'][number] {
  const ssims = measures.map((m) => m.ssim);
  const rates = measures.map((m) => (m.bytes * 8) / m.durationSec); // bit/s
  const minRate = Math.min(...rates);
  const maxRate = Math.max(...rates);
  return {
    crf,
    minSsim: Math.min(...ssims),
    meanSsim: ssims.reduce((a, b) => a + b, 0) / ssims.length,
    estVideoBytesMin: Math.round((minRate * fullDurationSec) / 8),
    estVideoBytesMax: Math.round((maxRate * fullDurationSec) / 8),
  };
}

/**
 * 판정. 기준을 넘는 후보 중 가장 작은 용량(= 가장 큰 CRF)을 고른다.
 * 없으면 가장 높은 화질(가장 작은 CRF)을 notMet 으로 추천한다.
 */
export function judge(
  candidates: QualityRecommendation['candidates'],
  threshold = SSIM_THRESHOLD,
): { recommendedCrf: number; verdict: 'met' | 'notMet' } {
  if (candidates.length === 0) throw new AppError('INVALID_STATE', '후보가 없습니다');
  const sorted = [...candidates].sort((a, b) => a.crf - b.crf);
  const passing = sorted.filter((c) => c.minSsim >= threshold);
  if (passing.length > 0) {
    const pick = passing.at(-1); // 가장 큰 CRF = 가장 작은 용량
    if (pick) return { recommendedCrf: pick.crf, verdict: 'met' };
  }
  const first = sorted[0];
  if (!first) throw new AppError('INVALID_STATE', '후보가 없습니다');
  return { recommendedCrf: first.crf, verdict: 'notMet' };
}

export interface SampleRunInput {
  jobId: string;
  inputPath: string;
  probe: ProbeResult;
  settings: JobSettings;
  primaryIndex: number;
  ffmpegPath: string;
  tempRoot: string;
  signal: AbortSignal;
}

export class SampleEncodeService {
  constructor(private readonly proc: FFmpegProcessService) {}

  async recommend(input: SampleRunInput): Promise<QualityRecommendation> {
    const started = Date.now();
    const duration = input.probe.durationSec.value;
    if (duration === null || duration <= 0) {
      throw new AppError('UNSUPPORTED_SETTINGS', '재생 길이를 알 수 없어 샘플을 만들 수 없습니다');
    }
    const segments = planSegments(duration);
    const baseCrf = defaultCrfFor(input.settings);
    const crfs = candidateCrfs(baseCrf);
    const encoder = encoderFor(input.settings);
    if (encoder === 'copy') {
      throw new AppError(
        'UNSUPPORTED_SETTINGS',
        '원본 유지 모드에서는 품질 추천이 필요하지 않습니다',
      );
    }
    const pixFmt = outputPixFmt(input.probe, input.primaryIndex, input.settings.codec);
    const tmp = path.join(input.tempRoot, `sample-${input.jobId}`);
    fs.mkdirSync(tmp, { recursive: true });

    const deadline = started + SAMPLE_TOTAL_TIMEOUT_MS;
    const checkBudget = (): void => {
      if (input.signal.aborted) throw new AppError('CANCELLED');
      if (Date.now() > deadline) throw new AppError('SAMPLE_TIMEOUT');
    };

    try {
      // 1) 구간별 무손실 기준본
      const refs: string[] = [];
      for (const [i, seg] of segments.entries()) {
        checkBudget();
        const ref = path.join(tmp, `ref-${String(i)}.mkv`);
        await this.run(input, [
          '-n',
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-ss',
          String(seg.startSec),
          '-i',
          input.inputPath,
          '-t',
          String(seg.durationSec),
          '-map',
          `0:${String(input.primaryIndex)}`,
          '-an',
          '-sn',
          '-dn',
          '-c:v',
          'ffv1',
          '-pix_fmt',
          pixFmt,
          // 기준본과 후보가 같은 프레임 수·타임스탬프를 갖도록 둘 다 passthrough 로 만든다 (SSIM 정렬)
          '-fps_mode',
          'passthrough',
          ref,
        ]);
        refs.push(ref);
      }

      // 2) 후보별 인코딩과 측정
      const candidates: QualityRecommendation['candidates'] = [];
      for (const crf of crfs) {
        const measures: SegmentMeasure[] = [];
        for (const [i, seg] of segments.entries()) {
          checkBudget();
          const out = path.join(
            tmp,
            `cand-${String(crf)}-${String(i)}.${input.settings.container}`,
          );
          const codecArgs =
            encoder === 'libx265'
              ? [
                  '-c:v',
                  'libx265',
                  '-preset',
                  PRESET_SPECS[input.settings.preset].x265,
                  '-crf',
                  String(crf),
                ]
              : [
                  '-c:v',
                  'libx264',
                  '-preset',
                  PRESET_SPECS[input.settings.preset].x264,
                  '-crf',
                  String(crf),
                ];
          await this.run(input, [
            '-n',
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-ss',
            String(seg.startSec),
            '-i',
            input.inputPath,
            '-t',
            String(seg.durationSec),
            '-map',
            `0:${String(input.primaryIndex)}`,
            '-an',
            '-sn',
            '-dn',
            ...codecArgs,
            '-pix_fmt',
            pixFmt,
            '-fps_mode',
            'passthrough',
            '-f',
            input.settings.container === 'mp4' ? 'mp4' : 'matroska',
            out,
          ]);
          const bytes = fs.statSync(out).size;
          const ssim = await this.measureSsim(input, out, requireRef(refs, i));
          measures.push({ startSec: seg.startSec, durationSec: seg.durationSec, bytes, ssim });
          fs.rmSync(out, { force: true });
        }
        candidates.push(summarizeCandidate(crf, measures, duration));
      }

      const { recommendedCrf, verdict } = judge(candidates);
      return {
        method: 'ssim',
        threshold: SSIM_THRESHOLD,
        candidates,
        recommendedCrf,
        verdict,
        sampleSegments: segments,
        sampledSec: segments.reduce((a, s) => a + s.durationSec, 0),
        elapsedSec: round2((Date.now() - started) / 1000),
        note:
          verdict === 'met'
            ? '샘플 구간의 SSIM 최솟값이 기준을 넘는 후보 중 가장 작은 용량을 추천합니다. 샘플 평가이며 전체 영상 검증이 아닙니다.'
            : '기준을 넘는 후보가 없어 가장 높은 화질 후보를 추천합니다. 샘플 기준 화질 미달 가능성이 있습니다.',
        createdAt: new Date().toISOString(),
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async run(input: SampleRunInput, args: string[]): Promise<void> {
    const res = await this.proc.run(input.ffmpegPath, args, {
      jobId: input.jobId,
      signal: input.signal,
      timeoutMs: SAMPLE_CALL_TIMEOUT_MS,
    });
    if (res.cancelled) throw new AppError('CANCELLED');
    if (res.timedOut) throw new AppError('SAMPLE_TIMEOUT');
    if (res.exitCode !== 0) {
      throw new AppError(
        'ENCODE_FAILED',
        `샘플 인코딩 실패\n${res.stderrTail.slice(-10).join('\n')}`,
      );
    }
  }

  private async measureSsim(
    input: SampleRunInput,
    distorted: string,
    reference: string,
  ): Promise<number> {
    const res = await this.proc.run(
      input.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'info',
        '-nostdin',
        '-nostats',
        '-i',
        distorted,
        '-i',
        reference,
        '-lavfi',
        'ssim',
        '-f',
        'null',
        '-',
      ],
      { jobId: input.jobId, signal: input.signal, timeoutMs: SAMPLE_CALL_TIMEOUT_MS },
    );
    if (res.cancelled) throw new AppError('CANCELLED');
    if (res.timedOut) throw new AppError('SAMPLE_TIMEOUT');
    const text = res.stderrTail.join('\n');
    const v = parseSsimAll(text);
    if (v === null || res.exitCode !== 0) {
      throw new AppError(
        'ENCODE_FAILED',
        `SSIM 측정 실패 (코드 ${String(res.exitCode)})\n${text.slice(-500)}`,
      );
    }
    return v;
  }
}

function requireRef(refs: readonly string[], i: number): string {
  const ref = refs[i];
  if (!ref) throw new AppError('INVALID_STATE', '기준 구간이 없습니다');
  return ref;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
