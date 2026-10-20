/**
 * 단일 작업의 처리 파이프라인.
 *
 *   분석: probe → capability 판정 → 예상 결과 계산
 *   인코딩: 입력 변경 확인 → 디스크 검사 → 임시 파일로 인코딩(패스 단위) → 종료 코드 확인
 *   검증: OutputValidationService (기본 검증)
 *   확정: 크기 비교 → 결과가 더 크면 no_savings → 같은 볼륨 링크/이름 변경으로 확정
 *
 * 취소·실패 시 임시 파일과 2-pass 로그는 이 모듈이 만든 것만 지운다. 원본은 어떤 경우에도 건드리지 않는다.
 * 큐 관리와 DB 기록은 JobQueueService 가 맡는다. 이 파일은 상태 콜백만 호출한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  AnalysisResult,
  JobProgress,
  JobSettings,
  JobStatus,
  ProbeResult,
  ValidationReport,
} from '../../shared/types/domain';
import { AppError } from './AppError';
import { analyzeCapability, bytesPerMiB } from './CapabilityService';
import { buildEncodePlan, passLogPrefixIn, type EncodePlan } from './CompressionPolicyService';
import {
  assertDiskSpace,
  assertInputUnchanged,
  finalizeFile,
  isSamePath,
  removeAppTempFile,
  resolveFinalPath,
  tempOutputPath,
} from './FileFinalizeService';
import type { FFmpegProcessService } from './FFmpegProcessService';
import type { Logger } from '../platform/logger';
import { ProgressEstimator } from './ProgressEstimator';
import type { MediaProbeService } from './MediaProbeService';
import { OutputValidationService } from './OutputValidationService';

/** 목표 용량 모드 자동 재시도 상한 (최초 시도 포함) */
export const MAX_TARGET_ATTEMPTS = 3;
/** 목표 초과 시 다음 시도의 비트레이트 여유 계수 */
export const TARGET_RETRY_SAFETY = 0.97;
/** 진행 정보가 이 시간 이상 없으면 멈춤으로 본다 */
export const ENCODE_STALL_TIMEOUT_MS = 10 * 60 * 1000;

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
  /** ffmpeg -version 첫 줄 */
  version: string;
}

export interface EncodeContext {
  jobId: string;
  inputPath: string;
  inputSizeBytes: number;
  inputMtimeMs: number;
  settings: JobSettings;
  probe: ProbeResult;
  analysis: AnalysisResult;
  outputDir: string;
  outputSuffix: string;
  keepLargerResults: boolean;
  /** 앱 임시 루트 (userData/tmp). 작업별 하위 디렉터리를 만든다. */
  tempRoot: string;
  /** 같은 대기열 안에서 이미 예약된 출력 경로 (정규화된 값) */
  reservedOutputs: ReadonlySet<string>;
  signal: AbortSignal;
  historicalSpeed: number | null;
  /** 빠른 압축에서 사용할 하드웨어 인코더 (없으면 CPU) */
  hardwareEncoder: { name: string; family: 'nvenc' | 'qsv' | 'amf' } | null;
  callbacks: {
    onStatus: (status: JobStatus) => void;
    onProgress: (p: JobProgress) => void;
    /** 임시 출력 경로가 정해지면 호출한다 (중단 복구용으로 DB 에 기록) */
    onTempOutput: (tempPath: string | null, tempDir: string | null) => void;
    onEncoderVersion: (version: string) => void;
  };
}

export interface EncodeOutcome {
  status: 'completed' | 'no_savings';
  outputPath: string | null;
  outputSizeBytes: number;
  savingsRatio: number;
  validation: ValidationReport;
  encoderName: string;
}

export class JobRunner {
  constructor(
    private readonly proc: FFmpegProcessService,
    private readonly probeService: MediaProbeService,
    private readonly validator: OutputValidationService,
    private readonly logger: Logger,
    private readonly tools: () => ToolPaths,
  ) {}

  /** 분석 단계: probe 와 capability 판정 */
  async analyze(
    inputPath: string,
    settings: JobSettings,
    jobId: string,
    historicalSpeed: number | null,
  ): Promise<{ probe: ProbeResult; analysis: AnalysisResult }> {
    const probe = await this.probeService.probe(inputPath, jobId);
    const analysis = analyzeCapability(probe, settings, { historicalSpeed });
    return { probe, analysis };
  }

  async encode(ctx: EncodeContext): Promise<EncodeOutcome> {
    const { jobId, settings, analysis, signal } = ctx;
    this.logger.info('encode start', {
      jobId,
      mode: settings.mode,
      codec: settings.codec,
      container: settings.container,
    });

    // 1) 분석 이후 입력이 바뀌었는지 확인
    assertInputUnchanged(ctx.inputPath, {
      sizeBytes: ctx.inputSizeBytes,
      mtimeMs: ctx.inputMtimeMs,
    });

    // 2) 차단된 설정은 실행하지 않는다
    if (analysis.support === 'blocked') {
      const first = analysis.limitations.find((l) => l.severity === 'blocking');
      throw new AppError('UNSUPPORTED_SETTINGS', first?.message ?? '차단된 설정입니다');
    }
    throwIfAborted(signal);

    const tools = this.tools();
    const baseName = path.parse(ctx.inputPath).name + ctx.outputSuffix;
    const tempPath = tempOutputPath(ctx.outputDir, baseName, jobId, settings.container);
    if (isSamePath(tempPath, ctx.inputPath)) {
      throw new AppError('OUTPUT_PATH_CONFLICT', '임시 출력 경로가 원본과 같습니다');
    }

    // 3) 디스크 여유 검사: 원본 크기(최악)와 목표 용량 중 큰 값 기준
    const targetBytes =
      settings.mode === 'target' && settings.targetMiB ? bytesPerMiB(settings.targetMiB) : 0;
    assertDiskSpace(ctx.outputDir, Math.max(ctx.inputSizeBytes, targetBytes));

    const tempDir = path.join(ctx.tempRoot, jobId);
    fs.mkdirSync(tempDir, { recursive: true });
    ctx.callbacks.onTempOutput(tempPath, tempDir);

    try {
      ctx.callbacks.onStatus('encoding');
      ctx.callbacks.onEncoderVersion(tools.version);

      const maxAttempts = settings.mode === 'target' ? MAX_TARGET_ATTEMPTS : 1;
      let kbpsOverride: number | null = null;
      let attempt = 0;
      let outSize = 0;
      let validation: ValidationReport | null = null;
      let encoderName = 'copy';
      let hwActive = ctx.hardwareEncoder !== null;
      let hwFallbackNote: string | null = null;

      for (attempt = 1; attempt <= maxAttempts; attempt++) {
        throwIfAborted(signal);
        removeAppTempFile(tempPath); // -n 옵션으로 덮어쓰기를 막으므로 이전 시도 결과를 먼저 지운다
        const plan = buildEncodePlan(ctx.probe, settings, analysis, {
          inputPath: ctx.inputPath,
          outputPath: tempPath,
          passLogPrefix: passLogPrefixIn(path.join(tempDir, `attempt-${String(attempt)}`)),
          videoKbpsOverride: kbpsOverride,
          hardwareEncoder: hwActive ? ctx.hardwareEncoder : null,
          nullSink: process.platform === 'win32' ? 'NUL' : '/dev/null',
        });
        encoderName = hwFallbackNote
          ? `${plan.encoderLabel} · ${hwFallbackNote}`
          : plan.encoderLabel;
        if (plan.passLogPrefix) fs.mkdirSync(path.dirname(plan.passLogPrefix), { recursive: true });
        this.logger.info('plan', {
          jobId,
          attempt,
          passes: plan.passCount,
          encoder: plan.encoder,
          videoKbps: plan.videoKbps,
        });

        try {
          await this.runPasses(plan, { jobId, ctx, tools, signal });
        } catch (err) {
          // 하드웨어 인코더 실패: CPU 로 한 번 대체하고 같은 시도를 다시 한다 (시도 횟수는 소모하지 않는다)
          const app = AppError.from(err);
          if (hwActive && app.code === 'ENCODE_FAILED') {
            hwActive = false;
            hwFallbackNote = `${ctx.hardwareEncoder?.name ?? 'GPU'} 실패 후 CPU 로 대체`;
            this.logger.warn('hardware encoder failed, falling back to CPU', {
              jobId,
              encoder: ctx.hardwareEncoder?.name,
              detail: app.detail,
            });
            attempt -= 1;
            continue;
          }
          throw app;
        }

        throwIfAborted(signal);
        ctx.callbacks.onStatus('validating');
        ctx.callbacks.onProgress({ ratio: 1, speed: null, etaSec: null, outTimeSec: null });

        validation = await this.validator.validate({
          inputProbe: ctx.probe,
          settings,
          analysis,
          outputPath: tempPath,
          ffmpegPath: tools.ffmpeg,
          ffprobePath: tools.ffprobe,
          jobId,
        });
        if (!validation.passed) {
          removeAppTempFile(tempPath);
          throw new AppError(
            'VALIDATION_FAILED',
            validation.checks
              .filter((c) => !c.passed)
              .map((c) => `${c.label}: ${c.detail}`)
              .join('\n'),
          );
        }
        outSize = fs.statSync(tempPath).size;

        // 목표 용량: 초과하면 비트레이트를 낮춰 재시도 (상한 있음). 초과 결과를 성공으로 표시하지 않는다.
        if (settings.mode === 'target' && targetBytes > 0 && outSize > targetBytes) {
          if (attempt >= maxAttempts) {
            removeAppTempFile(tempPath);
            throw new AppError(
              'TARGET_EXCEEDED',
              `결과 ${String(outSize)} 바이트, 목표 ${String(targetBytes)} 바이트`,
            );
          }
          const currentKbps = plan.videoKbps ?? 1;
          kbpsOverride = Math.max(
            1,
            Math.floor(currentKbps * ((targetBytes * TARGET_RETRY_SAFETY) / outSize)),
          );
          this.logger.info('target exceeded, retry', {
            jobId,
            attempt,
            outSize,
            targetBytes,
            nextKbps: kbpsOverride,
          });
          ctx.callbacks.onStatus('encoding');
          continue;
        }
        break;
      }

      // 4) 크기 비교 → 확정 또는 no_savings
      // 검증 이후 취소가 들어왔다면 확정하지 않는다 (취소와 확정이 경합하지 않도록 마지막으로 확인)
      throwIfAborted(signal);
      const savingsRatio = (ctx.inputSizeBytes - outSize) / ctx.inputSizeBytes;
      const isLarger = savingsRatio <= 0;
      if (isLarger && !ctx.keepLargerResults) {
        removeAppTempFile(tempPath);
        ctx.callbacks.onTempOutput(null, tempDir);
        return {
          status: 'no_savings',
          outputPath: null,
          outputSizeBytes: outSize,
          savingsRatio,
          validation: validation as ValidationReport,
          encoderName,
        };
      }

      const finalPath = resolveFinalPath(
        ctx.outputDir,
        baseName,
        settings.container,
        ctx.inputPath,
        ctx.reservedOutputs,
      );
      finalizeFile(tempPath, finalPath);
      ctx.callbacks.onTempOutput(null, tempDir);
      this.logger.info('finalized', {
        jobId,
        outputSizeBytes: outSize,
        savingsRatio,
        attempts: attempt,
      });
      return {
        status: isLarger ? 'no_savings' : 'completed',
        outputPath: finalPath,
        outputSizeBytes: outSize,
        savingsRatio,
        validation: validation as ValidationReport,
        encoderName,
      };
    } finally {
      // 성공·실패·취소 모두 작업 전용 임시 디렉터리를 정리한다. 임시 출력 파일은 위에서 개별 처리했다.
      removeAppTempFile(tempPath);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** 계획의 모든 패스를 순서대로 실행한다. 종료 코드·멈춤·취소를 구분해 오류 코드로 바꾼다. */
  private async runPasses(
    plan: EncodePlan,
    env: { jobId: string; ctx: EncodeContext; tools: ToolPaths; signal: AbortSignal },
  ): Promise<void> {
    const { jobId, ctx, tools, signal } = env;
    for (let i = 0; i < plan.passes.length; i++) {
      const args = plan.passes[i] as string[];
      const estimator = new ProgressEstimator(ctx.probe.durationSec.value, Date.now());
      const result = await this.proc.run(tools.ffmpeg, args, {
        jobId,
        signal,
        stallTimeoutMs: ENCODE_STALL_TIMEOUT_MS,
        onProgress: (s) => {
          const snap = estimator.update(s.outTimeSec, s.speed, Date.now(), {
            index: i,
            count: plan.passCount,
          });
          ctx.callbacks.onProgress({
            ratio: snap.ratio,
            speed: snap.speed,
            etaSec: snap.etaSec,
            outTimeSec: snap.outTimeSec,
          });
        },
        onStderrLine: (line) => {
          if (/error|invalid|failed/i.test(line)) this.logger.warn('ffmpeg', { jobId, line });
        },
      });
      if (result.cancelled || signal.aborted) throw new AppError('CANCELLED');
      if (result.stalled)
        throw new AppError('ENCODE_STALLED', result.stderrTail.slice(-5).join('\n'));
      if (result.exitCode !== 0 || result.signal) {
        throw new AppError(
          'ENCODE_FAILED',
          `코드 ${String(result.exitCode)}${result.signal ? ` 신호 ${result.signal}` : ''}\n${result.stderrTail.slice(-20).join('\n')}`,
        );
      }
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError('CANCELLED');
}
