/**
 * 작업 큐 오케스트레이션.
 *
 * 동작 원칙
 * - 분석(probe·capability)은 직렬로 수행한다. 인코딩과는 별개 흐름이다.
 * - 인코딩은 동시에 1개만 실행한다 (기본 동시 인코딩 수 1).
 * - 일시정지는 "현재 작업 완료 후 다음 작업 시작 중지"다. 실행 중인 작업을 멈추지 않는다.
 * - 상태 변경은 모두 허용 전이표(JOB_TRANSITIONS)를 거치고, 변경마다 DB 기록과 렌더러 이벤트를 남긴다.
 * - 앱 재실행 시 실행 중이던 작업은 interrupted 로 바꾸고, 앱이 만든 임시 파일만 정리한다.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AddResult,
  AnalysisResult,
  HardwareEncoderStatus,
  JobProgress,
  JobSettings,
  JobStatus,
  JobView,
  QueueState,
  SkippedInput,
} from '../../shared/types/domain';
import { ERROR_CATALOG } from '../../shared/types/errors';
import type { EventChannel } from '../../shared/contracts/ipc';
import type { JobRepository, JobPatch, JobRow, NewJob } from '../repositories/JobRepository';
import { toView } from '../repositories/JobRepository';
import type { SettingsRepository } from '../repositories/SettingsRepository';
import type { Logger } from '../platform/logger';
import { AppError } from './AppError';
import { analyzeCapability } from './CapabilityService';
import { assertTransition } from './JobStateMachine';
import { isAppTempFile, normalizeForCompare, removeAppTempFile } from './FileFinalizeService';
import type { JobRunner, ToolPaths } from './JobRunner';
import type { SampleEncodeService } from './SampleEncodeService';

/** 폴더 추가 시 후보로 삼을 확장자. 실제 판정은 ffprobe 가 한다. 파일 직접 선택에는 적용하지 않는다. */
export const VIDEO_EXTENSIONS = [
  '.mp4',
  '.m4v',
  '.mov',
  '.mkv',
  '.avi',
  '.webm',
  '.wmv',
  '.flv',
  '.mpg',
  '.mpeg',
  '.ts',
  '.mts',
  '.m2ts',
  '.3gp',
  '.ogv',
];

export const MAX_SCAN_FILES = 5000;
const PROGRESS_EMIT_INTERVAL_MS = 200;
/** 실행 중(슬롯 점유) 상태 */
const BUSY: readonly JobStatus[] = ['encoding', 'validating', 'cancelling'];
/** 재시도 시 처음부터 다시 분석하는 상태 (ready 는 설정만 바꿀 수 있으므로 제외) */
const RETRYABLE: readonly JobStatus[] = [
  'failed',
  'cancelled',
  'interrupted',
  'completed',
  'no_savings',
];
/** 목록에서 삭제할 수 있는 상태 */
const DELETABLE: readonly JobStatus[] = [
  'ready',
  'queued',
  'completed',
  'no_savings',
  'failed',
  'cancelled',
  'interrupted',
];

export type Emit = (channel: EventChannel, payload: unknown) => void;

export interface QueueDeps {
  jobs: JobRepository;
  settings: SettingsRepository;
  runner: JobRunner;
  sampler: SampleEncodeService;
  logger: Logger;
  tempRoot: string;
  /** 도구 경로. 탐지되지 않았으면 TOOL_NOT_FOUND 를 던진다. */
  tools: () => ToolPaths;
  /** 하드웨어 인코더 검사 결과 (없으면 빈 목록) */
  hardwareStatuses: () => HardwareEncoderStatus[];
  emit: Emit;
  now?: () => Date;
}

type TransitionPatch = JobPatch & { statusMessage?: string | null };

export class JobQueueService {
  private paused = false;
  private running: { jobId: string; controller: AbortController } | null = null;
  private analysisChain: Promise<void> = Promise.resolve();
  private pumping = false;
  /** 샘플 추천 실행 중인 작업과 취소 컨트롤러 */
  private readonly sampling = new Map<string, AbortController>();

  constructor(private readonly deps: QueueDeps) {}

  // -------------------------------------------------------------------------
  // 공개 API
  // -------------------------------------------------------------------------

  queueState(): QueueState {
    return { paused: this.paused, runningJobId: this.running?.jobId ?? null };
  }

  list(): JobView[] {
    return this.withPositions(this.deps.jobs.list()).map(toView);
  }

  get(id: string): JobRow {
    const row = this.deps.jobs.get(id);
    if (!row) throw new AppError('INVALID_REQUEST', `작업을 찾을 수 없습니다: ${id}`);
    return row;
  }

  /**
   * 경로를 등록한다. 파일이면 그대로, 폴더이면 영상 후보 확장자로 훑는다.
   * 같은 정규화 경로가 진행 중이면 중복으로 건너뛴다.
   */
  addPaths(paths: readonly string[], includeSubfolders: boolean): AddResult {
    const skipped: SkippedInput[] = [];
    const candidates: string[] = [];

    for (const p of paths) {
      let st: fs.Stats;
      try {
        st = fs.statSync(p);
      } catch {
        skipped.push({ path: p, reason: '경로를 찾을 수 없습니다' });
        continue;
      }
      if (st.isFile()) candidates.push(p);
      else if (st.isDirectory()) candidates.push(...scanFolder(p, includeSubfolders, skipped));
      else skipped.push({ path: p, reason: '일반 파일이나 폴더가 아닙니다' });
    }

    const defaults = this.deps.settings.get().defaults;
    const added: string[] = [];
    const seenInBatch = new Set<string>();
    let order = this.deps.jobs.maxQueueOrder();
    for (const file of candidates) {
      const key = normalizeForCompare(file);
      if (seenInBatch.has(key)) {
        skipped.push({ path: file, reason: '같은 요청에 중복으로 포함되어 있습니다' });
        continue;
      }
      seenInBatch.add(key);
      if (this.deps.jobs.findActiveByPathKey(key)) {
        skipped.push({ path: file, reason: '이미 목록에 있는 파일입니다' });
        continue;
      }
      const st = fs.statSync(file);
      const id = randomUUID();
      order += 1;
      const job: NewJob = {
        id,
        inputPath: file,
        inputPathKey: key,
        fileName: path.basename(file),
        inputSizeBytes: st.size,
        inputMtimeMs: st.mtimeMs,
        settings: { ...defaults },
        queueOrder: order,
        createdAt: this.now(),
      };
      this.deps.jobs.insert(job);
      this.deps.jobs.appendEvent(id, null, 'probing', '등록', this.now());
      added.push(id);
      this.scheduleAnalysis(id);
    }
    this.emitQueueChanged();
    return { added: added.map((id) => this.emitJob(id)), skipped };
  }

  /** 설정 변경. 분석 결과는 저장된 probe 로 다시 계산하므로 ffprobe 를 다시 실행하지 않는다. */
  updateSettings(id: string, patch: Partial<JobSettings>): JobView {
    const row = this.get(id);
    if (row.status !== 'ready') {
      throw new AppError('INVALID_STATE', '분석이 끝난 대기 작업(ready)의 설정만 바꿀 수 있습니다');
    }
    const next: JobSettings = { ...row.settings, ...patch };
    // CRF 는 코덱마다 의미가 다르므로 코덱이 바뀌면 샘플로 정한 값을 버린다
    if (patch.codec !== undefined && patch.codec !== row.settings.codec) next.crf = null;
    if (next.mode === 'target' && (next.targetMiB === null || next.targetMiB <= 0)) {
      throw new AppError('INVALID_REQUEST', '목표 용량 모드에서는 목표 용량(MB)을 입력해야 합니다');
    }
    const analysis: AnalysisResult | null = row.probe
      ? analyzeCapability(row.probe, next, { historicalSpeed: this.historicalSpeed(next) })
      : null;
    this.deps.jobs.update(id, { settings: next, analysis });
    return this.emitJob(id);
  }

  /** 같은 상태 그룹 안에서 순서를 한 칸 옮긴다. 실행 중인 작업은 옮기지 않는다. */
  move(id: string, direction: 'up' | 'down'): JobView[] {
    const row = this.get(id);
    if (BUSY.includes(row.status)) {
      throw new AppError('INVALID_STATE', '실행 중인 작업은 순서를 바꿀 수 없습니다');
    }
    const ordered = this.deps.jobs.list();
    const idx = ordered.findIndex((j) => j.id === id);
    const neighbor = ordered[direction === 'up' ? idx - 1 : idx + 1];
    if (idx >= 0 && neighbor && !BUSY.includes(neighbor.status)) {
      this.deps.jobs.update(id, { queueOrder: neighbor.queueOrder });
      this.deps.jobs.update(neighbor.id, { queueOrder: row.queueOrder });
    }
    this.emitQueueChanged();
    return this.list();
  }

  /** ready 작업을 실행 대기열(queued)로 넘기고 실행을 시도한다. 차단된 작업은 넘어가지 않는다. */
  start(ids: readonly string[] | null): JobView[] {
    const targets = this.deps.jobs
      .listByStatus(['ready'])
      .filter((j) => ids === null || ids.includes(j.id))
      .filter((j) => j.analysis !== null && j.analysis.support !== 'blocked');
    for (const j of targets) this.transition(j.id, 'queued');
    for (const j of targets) this.emitJob(j.id);
    this.pump();
    return this.list();
  }

  unqueue(id: string): JobView {
    const row = this.get(id);
    if (row.status !== 'queued')
      throw new AppError('INVALID_STATE', '대기열 작업만 되돌릴 수 있습니다');
    this.transition(id, 'ready');
    return this.emitJob(id);
  }

  /**
   * 샘플 품질 추천. 준비됨 상태의 고품질·빠른 모드 작업에만 쓴다.
   * 실행 결과는 추천 정보로만 저장하며 설정을 자동으로 바꾸지 않는다 (사용자가 적용해야 한다).
   */
  async recommend(id: string): Promise<JobView> {
    const row = this.get(id);
    if (row.status !== 'ready' || !row.probe || !row.analysis) {
      throw new AppError('INVALID_STATE', '분석이 끝난 준비됨 상태의 작업만 추천할 수 있습니다');
    }
    if (row.settings.mode !== 'quality' && row.settings.mode !== 'fast') {
      throw new AppError(
        'INVALID_STATE',
        '고품질 자동 또는 빠른 압축 모드에서만 추천을 사용할 수 있습니다',
      );
    }
    if (row.analysis.primaryVideoIndex === null) {
      throw new AppError('INVALID_STATE', '주 영상 트랙이 없습니다');
    }
    if (this.sampling.has(id)) throw new AppError('INVALID_STATE', '이미 추천을 계산 중입니다');

    const controller = new AbortController();
    this.sampling.set(id, controller);
    this.emitJob(id);
    try {
      const tools = this.deps.tools();
      const recommendation = await this.deps.sampler.recommend({
        jobId: id,
        inputPath: row.inputPath,
        probe: row.probe,
        settings: row.settings,
        primaryIndex: row.analysis.primaryVideoIndex,
        ffmpegPath: tools.ffmpeg,
        tempRoot: this.deps.tempRoot,
        signal: controller.signal,
      });
      this.deps.jobs.update(id, { recommendation });
    } finally {
      this.sampling.delete(id);
    }
    return this.emitJob(id);
  }

  /** 샘플 추천을 취소한다. 취소되면 기록은 남기지 않는다. */
  cancelRecommend(id: string): void {
    const c = this.sampling.get(id);
    if (!c) throw new AppError('INVALID_STATE', '추천 계산 중인 작업이 아닙니다');
    c.abort();
  }

  /** 현재 실행 중인 작업을 취소한다. 실제 종료와 정리는 runJob 의 흐름에서 끝난다. */
  cancel(id: string): JobView {
    const row = this.get(id);
    if (this.running?.jobId !== id || !BUSY.includes(row.status) || row.status === 'cancelling') {
      throw new AppError('INVALID_STATE', '현재 실행 중인 작업만 취소할 수 있습니다');
    }
    this.transition(id, 'cancelling');
    this.running.controller.abort();
    return this.emitJob(id);
  }

  /** 종료된 작업을 처음부터 다시 분석한다. 이전 임시 파일은 정리한다. */
  retry(id: string): JobView {
    const row = this.get(id);
    if (!RETRYABLE.includes(row.status)) {
      throw new AppError('INVALID_STATE', '이 상태의 작업은 재시도할 수 없습니다');
    }
    this.cleanupTemp(row);
    this.transition(id, 'probing', {
      errorCode: null,
      errorDetail: null,
      statusMessage: null,
      outputPath: null,
      outputSizeBytes: null,
      savingsRatio: null,
      validation: null,
      progress: emptyProgress(),
      startedAt: null,
      finishedAt: null,
      probe: null,
      analysis: null,
    });
    this.scheduleAnalysis(id);
    return this.emitJob(id);
  }

  /** 기록만 삭제한다. 원본과 결과 파일은 건드리지 않는다. */
  remove(id: string): boolean {
    const row = this.get(id);
    if (!DELETABLE.includes(row.status)) {
      throw new AppError('INVALID_STATE', '실행 중이거나 분석 중인 작업은 삭제할 수 없습니다');
    }
    this.cleanupTemp(row);
    const removed = this.deps.jobs.delete(id);
    this.deps.emit('job:removed', { id });
    this.emitQueueChanged();
    return removed;
  }

  setPaused(paused: boolean): QueueState {
    this.paused = paused;
    this.emitQueueChanged();
    if (!paused) this.pump();
    return this.queueState();
  }

  /**
   * 앱 시작 시 호출. 이전 실행이 끝나지 않은 작업을 중단 상태로 만들고, 그 작업의 임시 파일을 정리한다.
   * 중간 지점 재개는 지원하지 않으므로 재시도하면 처음부터 다시 처리한다.
   */
  recoverInterrupted(): number {
    const stale = this.deps.jobs.listByStatus([
      'probing',
      'analyzing',
      'queued',
      'encoding',
      'validating',
      'cancelling',
    ]);
    for (const row of stale) {
      this.cleanupTemp(row);
      // cancelling 은 취소 완료 상태로만 전이할 수 있다
      const to: JobStatus = row.status === 'cancelling' ? 'cancelled' : 'interrupted';
      const info = to === 'cancelled' ? ERROR_CATALOG.CANCELLED : ERROR_CATALOG.INTERRUPTED;
      this.transition(row.id, to, {
        statusMessage: info.title,
        errorCode: to === 'cancelled' ? 'CANCELLED' : 'INTERRUPTED',
        errorDetail: `이전 상태: ${row.status}`,
        finishedAt: this.now(),
      });
    }
    // 어떤 작업에도 속하지 않는 임시 디렉터리(DB 기록 없는 잔여물)는 앱이 만든 것이므로 정리한다
    if (fs.existsSync(this.deps.tempRoot)) {
      const known = new Set(this.deps.jobs.list().map((j) => j.id));
      for (const name of fs.readdirSync(this.deps.tempRoot)) {
        if (!known.has(name))
          fs.rmSync(path.join(this.deps.tempRoot, name), { recursive: true, force: true });
      }
    }
    this.emitQueueChanged();
    return stale.length;
  }

  /** 앱 종료 시: 실행 중 작업을 취소 요청하고, 분석 체인이 끝날 때까지 기다린다. */
  async shutdown(): Promise<void> {
    this.paused = true;
    if (this.running) {
      const row = this.get(this.running.jobId);
      if (BUSY.includes(row.status) && row.status !== 'cancelling')
        this.transition(row.id, 'cancelling');
      this.running.controller.abort();
    }
    await this.analysisChain;
  }

  // -------------------------------------------------------------------------
  // 내부 구현
  // -------------------------------------------------------------------------

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }

  private historicalSpeed(settings: JobSettings): number | null {
    return this.deps.jobs.historicalSpeed(settings.codec, settings.preset);
  }

  /** 분석은 직렬 체인에 올려 한 번에 하나만 실행한다. */
  private scheduleAnalysis(id: string): void {
    this.analysisChain = this.analysisChain
      .then(() => this.analyzeJob(id))
      .catch((err: unknown) => {
        this.deps.logger.error('analysis chain error', { jobId: id, err: String(err) });
      });
  }

  private async analyzeJob(id: string): Promise<void> {
    const row = this.deps.jobs.get(id);
    if (!row || row.status !== 'probing') return;
    try {
      this.deps.tools(); // 도구가 없으면 여기서 실패한다
      const { probe, analysis } = await this.deps.runner.analyze(
        row.inputPath,
        row.settings,
        id,
        this.historicalSpeed(row.settings),
      );
      this.deps.jobs.update(id, { probe, analysis });
      this.transition(id, 'analyzing');
      this.transition(id, 'ready', {
        statusMessage: analysis.support === 'blocked' ? '처리 차단: 아래 사유를 확인하세요' : null,
      });
    } catch (err) {
      const app = AppError.from(err);
      this.deps.logger.warn('analysis failed', { jobId: id, code: app.code, detail: app.detail });
      this.transition(id, 'failed', this.failPatch(app));
    }
    this.emitJob(id);
  }

  /** 실행 슬롯이 비어 있으면 대기열 맨 앞 작업을 실행한다. 일시정지 상태에서는 실행하지 않는다. */
  private pump(): void {
    if (this.pumping || this.paused || this.running) return;
    const next = this.deps.jobs.listByStatus(['queued'])[0];
    if (!next) return;
    this.pumping = true;
    void this.runJob(next.id).finally(() => {
      this.pumping = false;
      this.running = null;
      this.emitQueueChanged();
      this.pump();
    });
  }

  private async runJob(id: string): Promise<void> {
    const controller = new AbortController();
    this.running = { jobId: id, controller };
    this.transition(id, 'encoding', {
      startedAt: this.now(),
      progress: emptyProgress(),
      errorCode: null,
      errorDetail: null,
      statusMessage: null,
    });
    this.emitJob(id);
    this.emitQueueChanged();

    const startedMs = Date.now();
    try {
      const row = this.get(id);
      if (!row.probe || !row.analysis) throw new AppError('INVALID_STATE', '분석 결과가 없습니다');
      const appSettings = this.deps.settings.get();
      const reserved = new Set(
        this.deps.jobs
          .listByStatus(['encoding', 'validating'])
          .filter((j) => j.outputPath)
          .map((j) => normalizeForCompare(j.outputPath as string)),
      );
      let lastEmit = 0;
      const outcome = await this.deps.runner.encode({
        jobId: id,
        inputPath: row.inputPath,
        inputSizeBytes: row.inputSizeBytes,
        inputMtimeMs: row.probe.mtimeMs,
        settings: row.settings,
        probe: row.probe,
        analysis: row.analysis,
        outputDir: this.resolveOutputDir(row),
        outputSuffix: appSettings.outputSuffix,
        keepLargerResults: appSettings.keepLargerResults,
        tempRoot: this.deps.tempRoot,
        reservedOutputs: reserved,
        signal: controller.signal,
        historicalSpeed: this.historicalSpeed(row.settings),
        hardwareEncoder: this.pickHardware(row.settings),
        callbacks: {
          onStatus: (status) => {
            this.transition(id, status);
            this.emitJob(id);
          },
          onProgress: (p: JobProgress) => {
            // 진행률은 DB 를 매번 갱신하되, 렌더러 이벤트는 간격을 두고 보낸다
            this.deps.jobs.update(id, { progress: p });
            const t = Date.now();
            if (t - lastEmit >= PROGRESS_EMIT_INTERVAL_MS || p.ratio === 1) {
              lastEmit = t;
              this.emitJob(id);
            }
          },
          onTempOutput: (tempPath, tempDir) => {
            this.deps.jobs.update(id, { tempOutputPath: tempPath, tempDir });
          },
          onEncoderVersion: (version) => {
            this.deps.jobs.update(id, { encoderVersion: version });
          },
        },
      });

      const wallSec = (Date.now() - startedMs) / 1000;
      const mediaSec = row.probe.durationSec.value;
      const avgSpeed = mediaSec && wallSec > 0 ? mediaSec / wallSec : null;
      const savedPct = (Math.abs(outcome.savingsRatio) * 100).toFixed(1);
      this.transition(id, outcome.status, {
        outputPath: outcome.outputPath,
        outputSizeBytes: outcome.outputSizeBytes,
        savingsRatio: outcome.savingsRatio,
        validation: outcome.validation,
        encoderName: outcome.encoderName,
        avgSpeed,
        finishedAt: this.now(),
        tempOutputPath: null,
        tempDir: null,
        statusMessage:
          outcome.status === 'no_savings'
            ? `결과가 원본보다 ${savedPct}% ${outcome.savingsRatio < 0 ? '큽니다' : '줄지 않았습니다'}. 원본은 그대로 유지됩니다.`
            : null,
        progress: { ratio: 1, speed: null, etaSec: 0, outTimeSec: null },
      });
    } catch (err) {
      const app = AppError.from(err);
      const current = this.get(id);
      this.cleanupTemp(current);
      if (app.code === 'CANCELLED' || current.status === 'cancelling') {
        this.transition(id, 'cancelled', {
          statusMessage: ERROR_CATALOG.CANCELLED.title,
          errorCode: 'CANCELLED',
          errorDetail: null,
          finishedAt: this.now(),
        });
      } else {
        this.deps.logger.error('encode failed', { jobId: id, code: app.code, detail: app.detail });
        this.transition(id, 'failed', this.failPatch(app));
      }
    } finally {
      this.emitJob(id);
    }
  }

  private failPatch(app: AppError): TransitionPatch {
    return {
      errorCode: app.code,
      errorDetail: app.detail,
      statusMessage: ERROR_CATALOG[app.code].title,
      finishedAt: this.now(),
    };
  }

  /** 빠른 압축에서 쓸 하드웨어 인코더. 설정이 꺼져 있거나 사용 가능한 것이 없으면 null (CPU). */
  private pickHardware(
    settings: JobSettings,
  ): { name: string; family: 'nvenc' | 'qsv' | 'amf' } | null {
    if (settings.mode !== 'fast' || !this.deps.settings.get().fastUseHardware) return null;
    const hit = this.deps.hardwareStatuses().find((h) => h.codec === settings.codec && h.available);
    return hit ? { name: hit.name, family: hit.family } : null;
  }

  private resolveOutputDir(row: JobRow): string {
    const s = this.deps.settings.get();
    if (s.outputFolderMode === 'custom') {
      if (!s.customOutputDir)
        throw new AppError('INVALID_REQUEST', '출력 폴더가 지정되지 않았습니다');
      fs.mkdirSync(s.customOutputDir, { recursive: true });
      return s.customOutputDir;
    }
    return path.dirname(row.inputPath);
  }

  /** 상태 전이 + DB 기록 + 전이 이력을 한 번에 처리한다. 허용되지 않은 전이는 예외다. */
  private transition(id: string, to: JobStatus, patch: TransitionPatch = {}): void {
    const row = this.get(id);
    if (row.status === to) {
      this.deps.jobs.update(id, { ...patch, status: to });
      return;
    }
    assertTransition(row.status, to);
    this.deps.jobs.update(id, { ...patch, status: to });
    this.deps.jobs.appendEvent(id, row.status, to, patch.statusMessage ?? null, this.now());
  }

  private cleanupTemp(row: JobRow): void {
    if (row.tempOutputPath && isAppTempFile(row.tempOutputPath))
      removeAppTempFile(row.tempOutputPath);
    if (row.tempDir && row.tempDir.startsWith(this.deps.tempRoot)) {
      fs.rmSync(row.tempDir, { recursive: true, force: true });
    }
    this.deps.jobs.update(row.id, { tempOutputPath: null, tempDir: null });
  }

  private withPositions(rows: JobRow[]): JobRow[] {
    const queued = rows.filter((r) => r.status === 'queued');
    return rows.map((r) => {
      const pos = queued.findIndex((q) => q.id === r.id);
      return { ...r, queuePosition: pos >= 0 ? pos + 1 : 0 };
    });
  }

  private emitJob(id: string): JobView {
    const row = this.get(id);
    const [withPos] = this.withPositions([row]);
    const view = { ...toView(withPos ?? row), sampling: this.sampling.has(id) };
    this.deps.emit('job:changed', view);
    return view;
  }

  private emitQueueChanged(): void {
    this.deps.emit('queue:changed', this.queueState());
  }
}

function emptyProgress(): JobProgress {
  return { ratio: null, speed: null, etaSec: null, outTimeSec: null };
}

/** 폴더를 훑어 영상 후보 파일을 찾는다. 심볼릭 링크는 따라가지 않는다(순환 방지). */
export function scanFolder(root: string, recursive: boolean, skipped: SkippedInput[]): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped.push({ path: dir, reason: '폴더를 읽을 수 없습니다' });
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (recursive) stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!VIDEO_EXTENSIONS.includes(path.extname(e.name).toLowerCase())) continue;
      out.push(full);
      if (out.length >= MAX_SCAN_FILES) {
        skipped.push({ path: root, reason: `최대 ${String(MAX_SCAN_FILES)}개까지만 등록합니다` });
        return out.sort((a, b) => a.localeCompare(b, 'ko'));
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b, 'ko'));
}
