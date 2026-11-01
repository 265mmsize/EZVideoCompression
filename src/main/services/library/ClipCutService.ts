/**
 * 라이브러리 영상의 구간을 새 파일로 자르기.
 *
 * - fast: 재인코딩 없이 스트림을 복사한다 (화질 그대로, 빠름). 시작은 구간 앞의 키프레임에 맞춰지므로
 *   결과가 요청 구간보다 조금 길 수 있다. 결과 길이를 화면에 그대로 보여 준다.
 * - exact: 재인코딩해 요청한 시점에 정확히 자른다 (H.264 CRF 18, AAC). 화질은 약간 바뀌고 시간이 걸린다.
 *
 * 원본은 읽기만 한다. 결과는 임시 파일로 만든 뒤 검증하고, 같은 폴더에 "-cut" 이름으로 확정한다. 덮어쓰지 않는다.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LibraryItem } from '../../../shared/types/domain';
import type { Logger } from '../../platform/logger';
import { AppError } from '../AppError';
import type { FFmpegProcessService } from '../FFmpegProcessService';
import {
  assertDiskSpace,
  finalizeFile,
  isSamePath,
  removeAppTempFile,
  resolveFinalPath,
  tempOutputPath,
} from '../FileFinalizeService';
import type { ToolPaths } from '../JobRunner';
import type { MediaProbeService } from '../MediaProbeService';

export type CutMode = 'fast' | 'exact';
/** 같은 컨테이너로 자를 수 있는 확장자. 그 밖의 입력은 MKV 로 만든다. */
export const CUT_CONTAINERS = ['mp4', 'm4v', 'mov', 'mkv'] as const;
const CUT_TIMEOUT_MS = 30 * 60_000;
export const MIN_CUT_SEC = 0.5;

export interface CutResult {
  outputPath: string;
  durationSec: number;
  sizeBytes: number;
  libraryItemId: string | null;
  mode: CutMode;
  /** 사용자에게 보여줄 설명 (복사 모드의 키프레임 정확도 등) */
  notes: string[];
}

export interface ClipCutDeps {
  get: (id: string) => LibraryItem;
  proc: FFmpegProcessService;
  probe: MediaProbeService;
  tools: () => ToolPaths;
  tempRoot: string;
  logger: Logger;
  indexFile: (filePath: string) => Promise<string | null>;
}

export function cutContainerFor(filePath: string): (typeof CUT_CONTAINERS)[number] | 'mkv' {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return (CUT_CONTAINERS as readonly string[]).includes(ext)
    ? (ext as (typeof CUT_CONTAINERS)[number])
    : 'mkv';
}

/** 인자 배열 (순수 함수). 입력 옵션으로 -ss, -t 를 넣어 구간만 읽는다. */
export function buildCutArgs(
  input: string,
  output: string,
  startSec: number,
  durationSec: number,
  mode: CutMode,
): string[] {
  const common = [
    '-n',
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-progress',
    'pipe:1',
    '-nostats',
  ];
  if (mode === 'fast') {
    return [
      ...common,
      '-ss',
      startSec.toFixed(3),
      '-i',
      input,
      '-t',
      durationSec.toFixed(3),
      '-map',
      '0',
      '-c',
      'copy',
      '-avoid_negative_ts',
      'make_zero',
      output,
    ];
  }
  return [
    ...common,
    '-i',
    input,
    '-ss',
    startSec.toFixed(3),
    '-t',
    durationSec.toFixed(3),
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    output,
  ];
}

export interface AudioExtractResult {
  outputPath: string;
  durationSec: number;
  sizeBytes: number;
  libraryItemId: string | null;
}

/** 음성만 MP3 로 (순수 함수). -vn 으로 영상 스트림을 버린다. */
export function buildAudioExtractArgs(input: string, output: string): string[] {
  return [
    '-n',
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-c:a',
    'libmp3lame',
    '-q:a',
    '2',
    output,
  ];
}

export class ClipCutService {
  constructor(private readonly deps: ClipCutDeps) {}

  async cut(id: string, startSec: number, endSec: number, mode: CutMode): Promise<CutResult> {
    const item = this.deps.get(id);
    if (item.kind !== 'video')
      throw new AppError('INVALID_REQUEST', '영상 항목만 구간을 자를 수 있습니다');
    if (item.missing || !fs.existsSync(item.path)) throw new AppError('MEDIA_NOT_FOUND', item.path);
    const dur = endSec - startSec;
    if (!Number.isFinite(dur) || dur < MIN_CUT_SEC) {
      throw new AppError('INVALID_REQUEST', `구간이 너무 짧습니다 (최소 ${String(MIN_CUT_SEC)}초)`);
    }
    if (item.durationSec !== null && endSec > item.durationSec + 0.05) {
      throw new AppError('INVALID_REQUEST', '구간 끝이 영상 길이를 넘습니다');
    }

    const ext = cutContainerFor(item.path);
    const dir = path.dirname(item.path);
    const baseName = `${path.parse(item.path).name}-cut`;
    const jobId = randomUUID();
    const temp = tempOutputPath(dir, baseName, jobId, ext);
    if (isSamePath(temp, item.path))
      throw new AppError('OUTPUT_PATH_CONFLICT', '임시 경로가 원본과 같습니다');
    assertDiskSpace(dir, Math.max(item.sizeBytes, 64 * 1024 * 1024));

    const tools = this.deps.tools();
    const args = buildCutArgs(item.path, temp, startSec, dur, mode);
    this.deps.logger.info('cut start', { id, mode, startSec, dur, ext });
    try {
      const res = await this.deps.proc.run(tools.ffmpeg, args, {
        jobId: `cut-${jobId}`,
        timeoutMs: CUT_TIMEOUT_MS,
      });
      if (res.exitCode !== 0 || !fs.existsSync(temp)) {
        throw new AppError(
          'ENCODE_FAILED',
          res.stderrTail.slice(-5).join('\n') || `코드 ${String(res.exitCode)}`,
        );
      }
      const out = await this.deps.probe.probe(temp, jobId);
      const v = out.streams.find((s) => s.kind === 'video' && !s.isAttachedPic);
      if (!v) throw new AppError('VALIDATION_FAILED', '결과에 영상 트랙이 없습니다');
      const outDur = out.durationSec.value ?? 0;
      // 복사 모드는 키프레임에서 시작하므로 짧아지지는 않는다. 정확 모드는 요청 길이에 가까워야 한다.
      if (mode === 'fast' && outDur < dur - 0.5) {
        throw new AppError(
          'VALIDATION_FAILED',
          `결과 ${outDur.toFixed(2)}초가 요청 ${dur.toFixed(2)}초보다 짧습니다`,
        );
      }
      if (mode === 'exact') {
        const tol = Math.max(0.5, dur * 0.01);
        if (Math.abs(outDur - dur) > tol) {
          throw new AppError(
            'VALIDATION_FAILED',
            `결과 ${outDur.toFixed(2)}초, 요청 ${dur.toFixed(2)}초 (허용 ${tol.toFixed(2)}초)`,
          );
        }
      }
      const finalPath = resolveFinalPath(dir, baseName, ext, item.path);
      finalizeFile(temp, finalPath);
      const sizeBytes = fs.statSync(finalPath).size;
      let libraryItemId: string | null = null;
      try {
        libraryItemId = await this.deps.indexFile(finalPath);
      } catch (err) {
        this.deps.logger.warn('indexing cut failed', { finalPath, err: String(err) });
      }
      const notes =
        mode === 'fast'
          ? [
              `재인코딩하지 않았습니다. 시작 지점은 앞쪽 키프레임에 맞춰져 결과가 ${(outDur - dur).toFixed(2)}초 길 수 있습니다.`,
            ]
          : ['재인코딩했습니다. 요청한 시점에 정확히 잘랐고 화질은 H.264 CRF 18 기준입니다.'];
      this.deps.logger.info('cut done', { id, finalPath, sizeBytes, outDur, mode });
      return { outputPath: finalPath, durationSec: outDur, sizeBytes, libraryItemId, mode, notes };
    } finally {
      removeAppTempFile(temp);
    }
  }

  /**
   * 영상의 음성만 MP3 로 추출한다 (재인코딩, 약 192kbps 가변). 원본은 읽기만 하고 같은 폴더에 "-audio.mp3" 로 저장한다.
   */
  async extractAudio(id: string): Promise<AudioExtractResult> {
    const item = this.deps.get(id);
    if (item.kind !== 'video')
      throw new AppError('INVALID_REQUEST', '영상 항목만 음성을 추출할 수 있습니다');
    if (item.missing || !fs.existsSync(item.path)) throw new AppError('MEDIA_NOT_FOUND', item.path);
    if (item.audioCodec === null)
      throw new AppError('INVALID_REQUEST', '음성 트랙이 없는 영상입니다');

    const dir = path.dirname(item.path);
    const baseName = `${path.parse(item.path).name}-audio`;
    const jobId = randomUUID();
    const temp = tempOutputPath(dir, baseName, jobId, 'mp3');
    if (isSamePath(temp, item.path))
      throw new AppError('OUTPUT_PATH_CONFLICT', '임시 경로가 원본과 같습니다');
    assertDiskSpace(dir, 64 * 1024 * 1024);

    const tools = this.deps.tools();
    this.deps.logger.info('audio extract start', { id });
    try {
      const res = await this.deps.proc.run(tools.ffmpeg, buildAudioExtractArgs(item.path, temp), {
        jobId: `audio-${jobId}`,
        timeoutMs: CUT_TIMEOUT_MS,
      });
      if (res.exitCode !== 0 || !fs.existsSync(temp)) {
        throw new AppError(
          'ENCODE_FAILED',
          res.stderrTail.slice(-5).join('\n') || `코드 ${String(res.exitCode)}`,
        );
      }
      const out = await this.deps.probe.probe(temp, jobId);
      const a = out.streams.find((x) => x.kind === 'audio');
      if (!a) throw new AppError('VALIDATION_FAILED', '결과에 음성 트랙이 없습니다');
      const outDur = out.durationSec.value ?? 0;
      const srcDur = item.durationSec ?? outDur;
      const tol = Math.max(0.5, srcDur * 0.01);
      if (Math.abs(outDur - srcDur) > tol) {
        throw new AppError(
          'VALIDATION_FAILED',
          `결과 ${outDur.toFixed(2)}초, 원본 ${srcDur.toFixed(2)}초`,
        );
      }
      const finalPath = resolveFinalPath(dir, baseName, 'mp3', item.path);
      finalizeFile(temp, finalPath);
      const sizeBytes = fs.statSync(finalPath).size;
      let libraryItemId: string | null = null;
      try {
        libraryItemId = await this.deps.indexFile(finalPath);
      } catch (err) {
        this.deps.logger.warn('indexing audio failed', { finalPath, err: String(err) });
      }
      return { outputPath: finalPath, durationSec: outDur, sizeBytes, libraryItemId };
    } finally {
      removeAppTempFile(temp);
    }
  }
}
