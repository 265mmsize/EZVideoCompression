/**
 * 결과 검증 (기본 검증).
 *
 * 수행하는 검사
 * - 파일 존재·크기, ffprobe 분석 성공
 * - 주 영상 트랙 존재, 코덱(재인코딩이면 목표 코덱), 해상도(회전 반영)
 * - 음성·자막·첨부 트랙 수가 분석 계획과 일치하는지
 * - 재생 길이: 입력과의 차이가 허용 오차 이내인지 (시간 기준 기반, 프레임 수 비교는 하지 않는다)
 * - 시작·중간·끝 지점 디코딩 (각 2초, 오류 출력이 있으면 실패)
 * - 스트림 복사 모드: 영상 패킷 수가 입력과 같은지
 *
 * 수행하지 않는 것
 * - 전체 프레임 디코딩, 화질 평가. 따라서 결과에는 basicOnly=true 를 붙이고
 *   화면에서 "전체 프레임 검증 완료"로 표시하지 않는다.
 */
import fs from 'node:fs';
import type {
  AnalysisResult,
  JobSettings,
  ProbeResult,
  ValidationCheck,
  ValidationReport,
} from '../../shared/types/domain';
import { AppError } from './AppError';
import type { FFmpegProcessService } from './FFmpegProcessService';
import type { MediaProbeService } from './MediaProbeService';
import { outputPixFmt } from './CompressionPolicyService';

/** 재생 길이 허용 오차: 최소 0.75초 또는 길이의 0.5% 중 큰 값 (프레임 단위 오차와 마지막 프레임 길이를 감안) */
export const DURATION_TOLERANCE_MIN_SEC = 0.75;
export const DURATION_TOLERANCE_RATIO = 0.005;
export const DECODE_SAMPLE_SEC = 2;

export interface ValidateInput {
  inputProbe: ProbeResult;
  settings: JobSettings;
  analysis: AnalysisResult;
  outputPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  jobId: string;
}

export function durationTolerance(inputDurationSec: number): number {
  return Math.max(DURATION_TOLERANCE_MIN_SEC, inputDurationSec * DURATION_TOLERANCE_RATIO);
}

/** 표시 회전이 90/270 이면 가로·세로가 바뀐다. 재인코딩 결과는 회전이 픽셀에 적용되어 있다. */
export function expectedDisplaySize(
  probe: ProbeResult,
  primaryIndex: number,
  reencoded: boolean,
): { width: number; height: number } | null {
  const v = probe.streams.find((s) => s.index === primaryIndex);
  if (!v?.width || !v.height) return null;
  const swap = reencoded && (v.rotation === 90 || v.rotation === 270);
  return swap ? { width: v.height, height: v.width } : { width: v.width, height: v.height };
}

export class OutputValidationService {
  constructor(
    private readonly probeService: MediaProbeService,
    private readonly proc: FFmpegProcessService,
  ) {}

  async validate(input: ValidateInput): Promise<ValidationReport> {
    const checks: ValidationCheck[] = [];
    const { settings, analysis, inputProbe, outputPath, ffmpegPath, ffprobePath, jobId } = input;
    const reencoded = settings.mode !== 'copy';
    const primaryIndex = analysis.primaryVideoIndex;
    if (primaryIndex === null) {
      return {
        passed: false,
        basicOnly: true,
        checks: [fail('primary', '주 영상', '분석 결과에 주 영상이 없습니다')],
      };
    }

    // 1) 파일 존재·크기
    let outSize: number;
    try {
      outSize = fs.statSync(outputPath).size;
    } catch {
      return {
        passed: false,
        basicOnly: true,
        checks: [fail('exists', '출력 파일 존재', '출력 파일을 찾을 수 없습니다')],
      };
    }
    checks.push(
      outSize > 0
        ? pass('exists', '출력 파일 존재', `${String(outSize)} 바이트`)
        : fail('exists', '출력 파일 존재', '크기가 0 입니다'),
    );

    // 2) ffprobe 분석
    let outProbe: ProbeResult;
    try {
      outProbe = await this.probeService.probe(outputPath, jobId);
      checks.push(pass('probe', 'ffprobe 분석', `스트림 ${String(outProbe.streams.length)}개`));
    } catch (err) {
      const detail = err instanceof AppError ? err.message : String(err);
      checks.push(fail('probe', 'ffprobe 분석', `출력 분석 실패: ${detail}`));
      return { passed: false, basicOnly: true, checks };
    }

    // 3) 주 영상 트랙 및 코덱
    const outVideos = outProbe.streams.filter((s) => s.kind === 'video' && !s.isAttachedPic);
    const outVideo = outVideos[0];
    if (!outVideo) {
      checks.push(fail('video', '주 영상 트랙', '출력에 영상 트랙이 없습니다'));
    } else {
      const expectedCodec = reencoded ? (settings.codec === 'h264' ? 'h264' : 'hevc') : null;
      const sourceCodec =
        inputProbe.streams.find((s) => s.index === primaryIndex)?.codecName ?? null;
      const codecOk =
        expectedCodec !== null
          ? outVideo.codecName === expectedCodec
          : outVideo.codecName === sourceCodec;
      checks.push(
        codecOk
          ? pass('codec', '영상 코덱', outVideo.codecName)
          : fail(
              'codec',
              '영상 코덱',
              `기대 ${expectedCodec ?? String(sourceCodec)}, 실제 ${outVideo.codecName}`,
            ),
      );
    }

    // 4) 해상도 (회전 반영)
    const expSize = expectedDisplaySize(inputProbe, primaryIndex, reencoded);
    if (outVideo && expSize) {
      const ok = outVideo.width === expSize.width && outVideo.height === expSize.height;
      checks.push(
        ok
          ? pass('size', '해상도', `${String(outVideo.width)}×${String(outVideo.height)}`)
          : fail(
              'size',
              '해상도',
              `기대 ${String(expSize.width)}×${String(expSize.height)}, 실제 ${String(outVideo.width)}×${String(outVideo.height)}`,
            ),
      );
    }

    // 5) 픽셀 포맷 (재인코딩 시 비트 심도 보존 확인)
    if (outVideo && reencoded) {
      const expFmt = outputPixFmt(inputProbe, primaryIndex, settings.codec);
      const outFmt = outVideo.pixFmt ?? 'unknown';
      checks.push(
        outFmt === expFmt
          ? pass('pixfmt', '픽셀 포맷', outFmt)
          : fail('pixfmt', '픽셀 포맷', `기대 ${expFmt}, 실제 ${outFmt}`),
      );
    }

    // 6) 음성·자막·첨부 트랙 보존
    const keptOf = (kind: 'audio' | 'subtitle' | 'attachment'): number =>
      analysis.tracks.filter((t) => t.kind === kind && t.action !== 'exclude').length;
    const countOf = (kind: 'audio' | 'subtitle' | 'attachment'): number =>
      outProbe.streams.filter((s) => s.kind === kind).length;
    for (const kind of ['audio', 'subtitle', 'attachment'] as const) {
      const expected = keptOf(kind);
      const actual = countOf(kind);
      const label =
        kind === 'audio' ? '음성 트랙' : kind === 'subtitle' ? '자막 트랙' : '첨부 트랙';
      checks.push(
        expected === actual
          ? pass(`tracks-${kind}`, label, `${String(actual)}개 보존`)
          : fail(`tracks-${kind}`, label, `계획 ${String(expected)}개, 출력 ${String(actual)}개`),
      );
    }

    // 7) 재생 길이 (시간 기준 허용 오차)
    const inDur = inputProbe.durationSec.value;
    const outDur = outProbe.durationSec.value;
    if (inDur === null || outDur === null) {
      checks.push({
        id: 'duration',
        label: '재생 길이',
        passed: true,
        detail: '길이를 확인할 수 없어 이 검사는 건너뛰었습니다',
      });
    } else {
      const tol = durationTolerance(inDur);
      const diff = Math.abs(outDur - inDur);
      checks.push(
        diff <= tol
          ? pass(
              'duration',
              '재생 길이',
              `입력 ${inDur.toFixed(2)}초, 출력 ${outDur.toFixed(2)}초 (차이 ${diff.toFixed(2)}초, 허용 ${tol.toFixed(2)}초)`,
            )
          : fail(
              'duration',
              '재생 길이',
              `차이 ${diff.toFixed(2)}초가 허용 ${tol.toFixed(2)}초를 넘습니다`,
            ),
      );
    }

    // 8) 시작·중간·끝 디코딩
    if (outVideo) {
      const points = decodePoints(outDur ?? inDur ?? 0);
      for (const [i, p] of points.entries()) {
        const res = await this.proc.run(
          ffmpegPath,
          [
            '-hide_banner',
            '-xerror',
            '-v',
            'error',
            '-ss',
            p.toFixed(3),
            '-i',
            outputPath,
            '-map',
            `0:${String(outVideo.index)}`,
            '-t',
            String(DECODE_SAMPLE_SEC),
            '-f',
            'null',
            '-',
          ],
          { timeoutMs: 120_000, jobId },
        );
        const errLines = res.stderrTail.filter((l) => l.trim().length > 0);
        const ok = res.exitCode === 0 && errLines.length === 0 && !res.timedOut;
        checks.push(
          ok
            ? pass(
                `decode-${String(i)}`,
                `디코딩 ${p.toFixed(1)}초 지점`,
                `${String(DECODE_SAMPLE_SEC)}초 구간 오류 없음`,
              )
            : fail(
                `decode-${String(i)}`,
                `디코딩 ${p.toFixed(1)}초 지점`,
                errLines.slice(-3).join(' / ') || `종료 코드 ${String(res.exitCode)}`,
              ),
        );
      }
    }

    // 9) 스트림 복사: 영상 패킷 수 일치
    if (settings.mode === 'copy' && outVideo) {
      const inCount = await this.countVideoPackets(
        ffprobePath,
        inputProbe.path,
        primaryIndex,
        jobId,
      );
      const outCount = await this.countVideoPackets(ffprobePath, outputPath, outVideo.index, jobId);
      if (inCount === null || outCount === null) {
        checks.push({
          id: 'packets',
          label: '영상 패킷 수',
          passed: false,
          detail: '패킷 수를 읽지 못했습니다',
        });
      } else {
        checks.push(
          inCount === outCount
            ? pass('packets', '영상 패킷 수', `${String(inCount)}개 (입력과 동일)`)
            : fail(
                'packets',
                '영상 패킷 수',
                `입력 ${String(inCount)}개, 출력 ${String(outCount)}개`,
              ),
        );
      }
    }

    // 10) 색상 정보 (전달 특성)
    const inColor = inputProbe.streams.find((s) => s.index === primaryIndex)?.colorTransfer ?? null;
    if (outVideo && inColor) {
      checks.push(
        outVideo.colorTransfer === inColor
          ? pass('color', '색 전달 특성', inColor)
          : fail(
              'color',
              '색 전달 특성',
              `입력 ${inColor}, 출력 ${outVideo.colorTransfer ?? '없음'}`,
            ),
      );
    }

    return {
      passed: checks.every((c) => c.passed),
      basicOnly: true,
      checks,
    };
  }

  private async countVideoPackets(
    ffprobePath: string,
    file: string,
    streamIndex: number,
    jobId: string,
  ): Promise<number | null> {
    const res = await this.proc.run(
      ffprobePath,
      [
        '-hide_banner',
        '-v',
        'error',
        '-count_packets',
        '-select_streams',
        String(streamIndex),
        '-show_entries',
        'stream=nb_read_packets',
        '-of',
        'csv=p=0',
        '-i',
        file,
      ],
      { timeoutMs: 600_000, captureStdout: true, jobId },
    );
    if (res.exitCode !== 0) return null;
    const n = Number.parseInt(res.stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }
}

/** 시작·중간·끝 디코딩 지점. 짧은 영상은 구간이 겹치지 않도록 범위 안으로 제한한다. */
export function decodePoints(durationSec: number): number[] {
  if (durationSec <= 0) return [0];
  // 마지막 구간의 시작 지점. 길이가 샘플 구간보다 짧으면 0 으로 줄여 범위를 넘지 않게 한다.
  const lastStart = Math.max(0, durationSec - DECODE_SAMPLE_SEC);
  const points = [0, lastStart / 2, lastStart];
  // 짧은 영상에서 지점이 겹치면 한 번만 검사한다
  return [...new Set(points.map((p) => Math.round(p * 1000) / 1000))];
}

function pass(id: string, label: string, detail: string): ValidationCheck {
  return { id, label, passed: true, detail };
}
function fail(id: string, label: string, detail: string): ValidationCheck {
  return { id, label, passed: false, detail };
}
