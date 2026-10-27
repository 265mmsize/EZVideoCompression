/**
 * 작업(jobs) 저장소. 내부 행 형태 ↔ 렌더러 DTO(JobView) 변환을 담당한다.
 *
 * 저장 규칙
 * - JSON 컬럼(settings, probe, analysis, validation)은 스키마 검증 없이 쓰지 않는다. 읽을 때 타입으로 단언한다.
 * - 입력 경로는 원본 표기 그대로 보관하고, 중복 검사에는 정규화된 input_path_key 를 쓴다.
 */
import type {
  AnalysisResult,
  JobProgress,
  JobSettings,
  JobStatus,
  JobView,
  ProbeResult,
  QualityRecommendation,
  ValidationReport,
} from '../../shared/types/domain';
import { ACTIVE_STATUSES } from '../../shared/types/domain';
import type { ErrorCode } from '../../shared/types/errors';
import type { Db } from '../database/Database';

export interface JobRow extends JobView {
  inputPathKey: string;
  queueOrder: number;
  tempOutputPath: string | null;
  tempDir: string | null;
  avgSpeed: number | null;
}

interface RawRow {
  id: string;
  input_path: string;
  input_path_key: string;
  file_name: string;
  input_size_bytes: number;
  input_mtime_ms: number;
  status: JobStatus;
  status_message: string | null;
  settings_json: string;
  probe_json: string | null;
  analysis_json: string | null;
  progress_json: string | null;
  output_path: string | null;
  output_size_bytes: number | null;
  savings_ratio: number | null;
  error_code: string | null;
  error_detail: string | null;
  validation_json: string | null;
  recommendation_json: string | null;
  encoder_name: string | null;
  encoder_version: string | null;
  avg_speed: number | null;
  temp_output_path: string | null;
  temp_dir: string | null;
  queue_order: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const TERMINAL_STATUSES: readonly JobStatus[] = [
  'completed',
  'no_savings',
  'failed',
  'cancelled',
  'interrupted',
];

const EMPTY_PROGRESS: JobProgress = { ratio: null, speed: null, etaSec: null, outTimeSec: null };

export interface NewJob {
  id: string;
  inputPath: string;
  inputPathKey: string;
  fileName: string;
  inputSizeBytes: number;
  inputMtimeMs: number;
  settings: JobSettings;
  queueOrder: number;
  createdAt: string;
}

export interface JobPatch {
  status?: JobStatus;
  statusMessage?: string | null;
  settings?: JobSettings;
  probe?: ProbeResult | null;
  analysis?: AnalysisResult | null;
  progress?: JobProgress;
  outputPath?: string | null;
  outputSizeBytes?: number | null;
  savingsRatio?: number | null;
  errorCode?: ErrorCode | null;
  errorDetail?: string | null;
  validation?: ValidationReport | null;
  recommendation?: QualityRecommendation | null;
  encoderName?: string | null;
  encoderVersion?: string | null;
  avgSpeed?: number | null;
  tempOutputPath?: string | null;
  tempDir?: string | null;
  queueOrder?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  inputSizeBytes?: number;
  inputMtimeMs?: number;
  fileName?: string;
}

export class JobRepository {
  constructor(private readonly db: Db) {}

  insert(job: NewJob): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, input_path, input_path_key, file_name, input_size_bytes, input_mtime_ms,
          status, settings_json, queue_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'probing', ?, ?, ?)`,
      )
      .run(
        job.id,
        job.inputPath,
        job.inputPathKey,
        job.fileName,
        job.inputSizeBytes,
        job.inputMtimeMs,
        JSON.stringify(job.settings),
        job.queueOrder,
        job.createdAt,
      );
  }

  get(id: string): JobRow | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  list(): JobRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status NOT IN ('completed','no_savings') ORDER BY queue_order ASC`,
      )
      .all() as unknown as RawRow[];
    return rows.map(toRow);
  }

  /** 이력: 완료·실패 등 종료된 작업을 최근순으로 */
  /** 종료된 작업(완료·크기 증가·실패·취소·중단)만 최근순으로. 진행 중 작업은 작업 목록에서 본다. */
  history(limit: number, offset: number): { items: JobRow[]; total: number } {
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(',');
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status IN (${placeholders})`)
        .get(...TERMINAL_STATUSES) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status IN (${placeholders})
         ORDER BY COALESCE(finished_at, created_at) DESC LIMIT ? OFFSET ?`,
      )
      .all(...TERMINAL_STATUSES, limit, offset) as unknown as RawRow[];
    return { items: rows.map(toRow), total };
  }

  listByStatus(statuses: readonly JobStatus[]): JobRow[] {
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY queue_order ASC`)
      .all(...statuses) as unknown as RawRow[];
    return rows.map(toRow);
  }

  /** 같은 정규화 경로가 진행 중인 작업이 있는지 */
  findActiveByPathKey(pathKey: string): JobRow | null {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT * FROM jobs WHERE input_path_key = ? AND status IN (${placeholders}) LIMIT 1`,
      )
      .get(pathKey, ...ACTIVE_STATUSES) as RawRow | undefined;
    return row ? toRow(row) : null;
  }

  /** 작업의 입력·출력 경로 또는 라이브러리 항목으로 기록된 경로인지 (탐색기 열기 허용 목록) */
  hasPath(path: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS hit FROM jobs WHERE input_path = ? OR output_path = ?
         UNION ALL SELECT 1 FROM library_items WHERE path = ? LIMIT 1`,
      )
      .get(path, path, path);
    return row !== undefined;
  }

  maxQueueOrder(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(queue_order), 0) AS m FROM jobs').get() as {
      m: number;
    };
    return row.m;
  }

  update(id: string, patch: JobPatch): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null): void => {
      sets.push(`${col} = ?`);
      values.push(v);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.statusMessage !== undefined) set('status_message', patch.statusMessage);
    if (patch.settings !== undefined) set('settings_json', JSON.stringify(patch.settings));
    if (patch.probe !== undefined)
      set('probe_json', patch.probe ? JSON.stringify(patch.probe) : null);
    if (patch.analysis !== undefined)
      set('analysis_json', patch.analysis ? JSON.stringify(patch.analysis) : null);
    if (patch.progress !== undefined) set('progress_json', JSON.stringify(patch.progress));
    if (patch.outputPath !== undefined) set('output_path', patch.outputPath);
    if (patch.outputSizeBytes !== undefined) set('output_size_bytes', patch.outputSizeBytes);
    if (patch.savingsRatio !== undefined) set('savings_ratio', patch.savingsRatio);
    if (patch.errorCode !== undefined) set('error_code', patch.errorCode);
    if (patch.errorDetail !== undefined) set('error_detail', patch.errorDetail);
    if (patch.validation !== undefined)
      set('validation_json', patch.validation ? JSON.stringify(patch.validation) : null);
    if (patch.recommendation !== undefined)
      set(
        'recommendation_json',
        patch.recommendation ? JSON.stringify(patch.recommendation) : null,
      );
    if (patch.encoderName !== undefined) set('encoder_name', patch.encoderName);
    if (patch.encoderVersion !== undefined) set('encoder_version', patch.encoderVersion);
    if (patch.avgSpeed !== undefined) set('avg_speed', patch.avgSpeed);
    if (patch.tempOutputPath !== undefined) set('temp_output_path', patch.tempOutputPath);
    if (patch.tempDir !== undefined) set('temp_dir', patch.tempDir);
    if (patch.queueOrder !== undefined) set('queue_order', patch.queueOrder);
    if (patch.startedAt !== undefined) set('started_at', patch.startedAt);
    if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt);
    if (patch.inputSizeBytes !== undefined) set('input_size_bytes', patch.inputSizeBytes);
    if (patch.inputMtimeMs !== undefined) set('input_mtime_ms', patch.inputMtimeMs);
    if (patch.fileName !== undefined) set('file_name', patch.fileName);
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  delete(id: string): boolean {
    const r = this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    return Number(r.changes) > 0;
  }

  appendEvent(
    jobId: string,
    from: JobStatus | null,
    to: JobStatus,
    message: string | null,
    at: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO job_events (job_id, at, from_status, to_status, message) VALUES (?, ?, ?, ?, ?)',
      )
      .run(jobId, at, from, to, message);
  }

  /**
   * 같은 설정(모드·코덱·프리셋)으로 끝난 작업들의 평균 실측 속도 (최근 5개 평균).
   * 모드를 포함하는 이유: 원본 유지(copy)는 수십 배 빠르므로 재인코딩 추정에 섞이면 안 된다.
   */
  historicalSpeed(mode: string, codec: string, preset: string): number | null {
    const rows = this.db
      .prepare(
        `SELECT avg_speed FROM jobs
         WHERE status IN ('completed','no_savings') AND avg_speed IS NOT NULL
           AND json_extract(settings_json, '$.mode') = ?
           AND json_extract(settings_json, '$.codec') = ?
           AND json_extract(settings_json, '$.preset') = ?
         ORDER BY finished_at DESC LIMIT 5`,
      )
      .all(mode, codec, preset) as { avg_speed: number }[];
    if (rows.length === 0) return null;
    return rows.reduce((a, r) => a + r.avg_speed, 0) / rows.length;
  }
}

function toRow(r: RawRow): JobRow {
  // crf, externalSubtitles 는 나중에 추가된 키이므로 이전 행에는 없을 수 있다
  const parsed = JSON.parse(r.settings_json) as Omit<JobSettings, 'crf' | 'externalSubtitles'> & {
    crf?: number | null;
    externalSubtitles?: boolean;
  };
  const settings: JobSettings = {
    ...parsed,
    crf: parsed.crf ?? null,
    externalSubtitles: parsed.externalSubtitles ?? true,
  };
  const progress = r.progress_json ? (JSON.parse(r.progress_json) as JobProgress) : EMPTY_PROGRESS;
  const probe = r.probe_json ? (JSON.parse(r.probe_json) as ProbeResult) : null;
  const analysis = r.analysis_json ? (JSON.parse(r.analysis_json) as AnalysisResult) : null;
  const validation = r.validation_json ? (JSON.parse(r.validation_json) as ValidationReport) : null;
  const recommendation = r.recommendation_json
    ? (JSON.parse(r.recommendation_json) as QualityRecommendation)
    : null;
  return {
    id: r.id,
    inputPath: r.input_path,
    inputPathKey: r.input_path_key,
    fileName: r.file_name,
    inputSizeBytes: r.input_size_bytes,
    status: r.status,
    statusMessage: r.status_message,
    settings,
    probe,
    analysis,
    progress,
    outputPath: r.output_path,
    outputSizeBytes: r.output_size_bytes,
    savingsRatio: r.savings_ratio,
    errorCode: r.error_code,
    errorDetail: r.error_detail,
    validation,
    recommendation,
    sampling: false,
    encoderName: r.encoder_name,
    encoderVersion: r.encoder_version,
    queuePosition: 0,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    queueOrder: r.queue_order,
    tempOutputPath: r.temp_output_path,
    tempDir: r.temp_dir,
    avgSpeed: r.avg_speed,
  };
}

/** 내부 행에서 렌더러용 DTO 만 남긴다 */
export function toView(row: JobRow): JobView {
  return {
    id: row.id,
    inputPath: row.inputPath,
    fileName: row.fileName,
    inputSizeBytes: row.inputSizeBytes,
    status: row.status,
    statusMessage: row.statusMessage,
    settings: row.settings,
    probe: row.probe,
    analysis: row.analysis,
    progress: row.progress,
    outputPath: row.outputPath,
    outputSizeBytes: row.outputSizeBytes,
    savingsRatio: row.savingsRatio,
    errorCode: row.errorCode,
    errorDetail: row.errorDetail,
    validation: row.validation,
    recommendation: row.recommendation,
    sampling: row.sampling,
    encoderName: row.encoderName,
    encoderVersion: row.encoderVersion,
    queuePosition: row.queuePosition,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
