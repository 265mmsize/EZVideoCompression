/**
 * 라이브러리 영상의 구간 자르기, 여러 구간 합치기, 음성 추출, 현재 프레임 저장.
 *
 * 방식 (킹컷의 고속·변환·스마트 컷에 대응)
 * - fast: 재인코딩 없이 스트림을 복사한다. 시작은 앞쪽 키프레임에 맞춰지므로 결과가 요청보다 조금 길 수 있다.
 * - exact: 재인코딩해 요청한 시점에 정확히 자른다 (H.264 CRF 18, AAC).
 * - smart: 시작 지점부터 다음 키프레임까지만 재인코딩하고, 나머지는 스트림 복사한다.
 *          검증에 실패하면 exact 로 대체하고 그 사실을 알린다.
 *
 * 원본은 읽기만 한다. 결과는 임시 파일로 만든 뒤 검증하고, 같은 폴더에 확정한다. 덮어쓰지 않는다.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CutMode, LibraryItem } from '../../../shared/types/domain';
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

/** 같은 컨테이너로 자를 수 있는 확장자. 그 밖의 입력은 MKV 로 만든다. */
export const CUT_CONTAINERS = ['mp4', 'm4v', 'mov', 'mkv'] as const;
const CUT_TIMEOUT_MS = 30 * 60_000;
export const MIN_CUT_SEC = 0.5;
export const MAX_CUT_RANGES = 20;
/** 스마트 컷에서 시작 지점과 키프레임 사이가 이보다 짧으면 그냥 복사한다 */
export const SMART_MIN_HEAD_SEC = 0.05;

export interface CutRange {
  startSec: number;
  endSec: number;
}

export interface CutResult {
  outputPath: string;
  durationSec: number;
  sizeBytes: number;
  libraryItemId: string | null;
  mode: CutMode;
  /** 사용자에게 보여줄 설명 (복사 모드의 키프레임 정확도, 스마트 컷의 재인코딩 구간 등) */
  notes: string[];
}

export interface AudioExtractResult {
  outputPath: string;
  durationSec: number;
  sizeBytes: number;
  libraryItemId: string | null;
}

export interface FrameSaveResult {
  outputPath: string;
  width: number;
  height: number;
  sizeBytes: number;
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

const COMMON = ['-n', '-hide_banner', '-loglevel', 'error', '-nostdin'];

/** 인자 배열 (순수 함수). 입력 옵션으로 -ss, -t 를 넣어 구간만 읽는다. */
export function buildCutArgs(
  input: string,
  output: string,
  startSec: number,
  durationSec: number,
  mode: 'fast' | 'exact',
): string[] {
  if (mode === 'fast') {
    return [
      ...COMMON,
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
    ...COMMON,
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

/** 여러 파일을 스트림 복사로 이어 붙이는 concat 목록 (순수 함수). 작은따옴표는 이스케이프한다. */
export function buildConcatListText(files: readonly string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

export function buildConcatArgs(listFile: string, output: string): string[] {
  return [
    ...COMMON,
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-map',
    '0',
    '-c',
    'copy',
    output,
  ];
}

export function buildFrameArgs(input: string, output: string, timeSec: number): string[] {
  return [
    ...COMMON,
    '-ss',
    timeSec.toFixed(3),
    '-i',
    input,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-update',
    '1',
    output,
  ];
}

/** 음성만 MP3 로 (순수 함수). -vn 으로 영상 스트림을 버린다. */
export function buildAudioExtractArgs(input: string, output: string): string[] {
  return [
    ...COMMON,
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

/**
 * ffprobe 패킷 목록("시각,플래그" 줄)에서 키프레임 시각만 고른다. 플래그에 K 가 있는 패킷이 키프레임이다.
 * 결과는 정렬된 숫자 배열이다.
 */
export function parseKeyframeTimes(stdout: string): number[] {
  const out: number[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const [t, flags] = line.split(',');
    if (flags === undefined || !flags.includes('K')) continue;
    const n = Number(t);
    if (Number.isFinite(n) && n >= 0) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** 시작 시각 이상인 첫 키프레임. 없으면 null. */
export function firstKeyframeAtOrAfter(times: readonly number[], t: number): number | null {
  for (const k of times) if (k >= t - 0.001) return k;
  return null;
}

/** 구간 목록이 자를 수 있는지 확인한다 (순수 함수). 잘못되면 사유 문자열, 맞으면 null. */
export function validateRanges(
  ranges: readonly CutRange[],
  durationSec: number | null,
): string | null {
  if (ranges.length === 0) return '구간이 없습니다';
  if (ranges.length > MAX_CUT_RANGES) return `구간은 최대 ${String(MAX_CUT_RANGES)}개입니다`;
  for (const r of ranges) {
    const d = r.endSec - r.startSec;
    if (!Number.isFinite(d) || d < MIN_CUT_SEC)
      return `구간이 너무 짧습니다 (최소 ${String(MIN_CUT_SEC)}초)`;
    if (durationSec !== null && r.endSec > durationSec + 0.05)
      return '구간 끝이 영상 길이를 넘습니다';
  }
  return null;
}

export class ClipCutService {
  constructor(private readonly deps: ClipCutDeps) {}

  /** 구간 하나 자르기 */
  cut(id: string, startSec: number, endSec: number, mode: CutMode): Promise<CutResult> {
    return this.cutRanges(id, [{ startSec, endSec }], mode);
  }

  /**
   * 여러 구간을 잘라 순서대로 한 파일로 합친다. 구간이 하나면 그 구간만 저장한다.
   * 결과 이름은 "-cut" 이고, 같은 이름이 있으면 번호를 붙인다. 원본은 바뀌지 않는다.
   */
  async cutRanges(id: string, ranges: CutRange[], mode: CutMode): Promise<CutResult> {
    const item = this.deps.get(id);
    if (item.kind !== 'video')
      throw new AppError('INVALID_REQUEST', '영상 항목만 구간을 자를 수 있습니다');
    if (item.missing || !fs.existsSync(item.path)) throw new AppError('MEDIA_NOT_FOUND', item.path);
    const bad = validateRanges(ranges, item.durationSec);
    if (bad) throw new AppError('INVALID_REQUEST', bad);

    const ext = cutContainerFor(item.path);
    const dir = path.dirname(item.path);
    const baseName = `${path.parse(item.path).name}-cut`;
    const jobId = randomUUID();
    const temp = tempOutputPath(dir, baseName, jobId, ext);
    if (isSamePath(temp, item.path))
      throw new AppError('OUTPUT_PATH_CONFLICT', '임시 경로가 원본과 같습니다');
    assertDiskSpace(dir, Math.max(item.sizeBytes, 64 * 1024 * 1024));

    const tools = this.deps.tools();
    const tempDir = path.join(this.deps.tempRoot, `cut-${jobId}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const notes: string[] = [];
    this.deps.logger.info('cut start', { id, mode, ranges: ranges.length });
    try {
      let outDur: number;
      if (ranges.length === 1) {
        const seg = await this.renderSegment(
          item.path,
          ranges[0] as CutRange,
          mode,
          temp,
          tempDir,
          0,
          jobId,
          tools,
        );
        notes.push(...seg.notes);
        outDur = seg.durationSec;
      } else {
        const segs: string[] = [];
        let expected = 0;
        for (const [i, r] of ranges.entries()) {
          const out = path.join(tempDir, `seg-${String(i)}.${ext}`);
          const seg = await this.renderSegment(item.path, r, mode, out, tempDir, i, jobId, tools);
          notes.push(...seg.notes);
          segs.push(out);
          expected += seg.durationSec;
        }
        const list = path.join(tempDir, 'concat.txt');
        fs.writeFileSync(list, buildConcatListText(segs), 'utf8');
        await this.run(tools.ffmpeg, buildConcatArgs(list, temp), jobId);
        const out = await this.deps.probe.probe(temp, jobId);
        outDur = out.durationSec.value ?? 0;
        const tol = Math.max(0.5, expected * 0.01);
        if (Math.abs(outDur - expected) > tol) {
          throw new AppError(
            'VALIDATION_FAILED',
            `합친 결과 ${outDur.toFixed(2)}초, 구간 합계 ${expected.toFixed(2)}초`,
          );
        }
        notes.push(`구간 ${String(ranges.length)}개를 하나로 합쳤습니다.`);
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
      this.deps.logger.info('cut done', { id, finalPath, sizeBytes, outDur, mode });
      return { outputPath: finalPath, durationSec: outDur, sizeBytes, libraryItemId, mode, notes };
    } finally {
      removeAppTempFile(temp);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /** 음성만 MP3 로 추출한다. 원본은 읽기만 하고 같은 폴더에 "-audio.mp3" 로 저장한다. */
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
    try {
      await this.run(tools.ffmpeg, buildAudioExtractArgs(item.path, temp), jobId);
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

  /** 지정한 시점의 프레임을 원본 해상도 PNG 로 저장한다 (킹플레이어 Ctrl+P 에 대응). */
  async saveFrame(id: string, timeSec: number): Promise<FrameSaveResult> {
    const item = this.deps.get(id);
    if (item.kind !== 'video')
      throw new AppError('INVALID_REQUEST', '영상 항목만 프레임을 저장할 수 있습니다');
    if (item.missing || !fs.existsSync(item.path)) throw new AppError('MEDIA_NOT_FOUND', item.path);
    const dur = item.durationSec;
    if (!Number.isFinite(timeSec) || timeSec < 0 || (dur !== null && timeSec > dur)) {
      throw new AppError('INVALID_REQUEST', '프레임 시점이 영상 길이 안에 있어야 합니다');
    }
    const dir = path.dirname(item.path);
    const baseName = `${path.parse(item.path).name}-frame-${timeSec.toFixed(2)}s`;
    const jobId = randomUUID();
    const temp = tempOutputPath(dir, baseName, jobId, 'png');
    assertDiskSpace(dir, 64 * 1024 * 1024);
    const tools = this.deps.tools();
    try {
      await this.run(tools.ffmpeg, buildFrameArgs(item.path, temp, timeSec), jobId);
      const out = await this.deps.probe.probe(temp, jobId);
      const v = out.streams.find((s) => s.kind === 'video');
      if (!v || !v.width || !v.height)
        throw new AppError('VALIDATION_FAILED', '저장된 프레임을 읽을 수 없습니다');
      const finalPath = resolveFinalPath(dir, baseName, 'png', item.path);
      finalizeFile(temp, finalPath);
      return {
        outputPath: finalPath,
        width: v.width,
        height: v.height,
        sizeBytes: fs.statSync(finalPath).size,
      };
    } finally {
      removeAppTempFile(temp);
    }
  }

  // -------------------------------------------------------------------------

  /**
   * 구간 하나를 dest 에 만든다. 실제 방식과 설명 문구, 길이를 돌려준다.
   * 스마트 컷이 실패하면 정확 모드로 대체하고 그 사실을 notes 에 남긴다.
   */
  private async renderSegment(
    input: string,
    r: CutRange,
    mode: CutMode,
    dest: string,
    tempDir: string,
    index: number,
    jobId: string,
    tools: ToolPaths,
  ): Promise<{ durationSec: number; notes: string[] }> {
    const dur = r.endSec - r.startSec;
    if (mode === 'fast') {
      await this.run(tools.ffmpeg, buildCutArgs(input, dest, r.startSec, dur, 'fast'), jobId);
      const p = await this.deps.probe.probe(dest, jobId);
      const outDur = p.durationSec.value ?? 0;
      if (outDur < dur - 0.5) {
        throw new AppError(
          'VALIDATION_FAILED',
          `결과 ${outDur.toFixed(2)}초가 요청 ${dur.toFixed(2)}초보다 짧습니다`,
        );
      }
      return {
        durationSec: outDur,
        notes: [
          '재인코딩하지 않았습니다. 시작 지점은 앞쪽 키프레임에 맞춰져 결과가 조금 길 수 있습니다.',
        ],
      };
    }
    if (mode === 'exact') {
      await this.run(tools.ffmpeg, buildCutArgs(input, dest, r.startSec, dur, 'exact'), jobId);
      const p = await this.deps.probe.probe(dest, jobId);
      return {
        durationSec: p.durationSec.value ?? dur,
        notes: ['재인코딩했습니다. 요청한 시점에 정확히 잘랐고 화질은 H.264 CRF 18 기준입니다.'],
      };
    }
    try {
      return await this.smartSegment(input, r, dest, tempDir, index, jobId, tools);
    } catch (err) {
      const app = AppError.from(err);
      if (app.code === 'CANCELLED') throw app;
      this.deps.logger.warn('smart cut failed, using exact', {
        code: app.code,
        detail: app.detail,
      });
      await this.run(tools.ffmpeg, buildCutArgs(input, dest, r.startSec, dur, 'exact'), jobId);
      const p = await this.deps.probe.probe(dest, jobId);
      return {
        durationSec: p.durationSec.value ?? dur,
        notes: ['스마트 컷 검증에 실패해 정확 모드로 대체했습니다.'],
      };
    }
  }

  private async smartSegment(
    input: string,
    r: CutRange,
    dest: string,
    tempDir: string,
    index: number,
    jobId: string,
    tools: ToolPaths,
  ): Promise<{ durationSec: number; notes: string[] }> {
    const dur = r.endSec - r.startSec;
    const kfs = await this.keyframes(input, jobId, tools.ffprobe);
    const k = firstKeyframeAtOrAfter(kfs, r.startSec);
    const notes: string[] = [];
    if (k === null || k >= r.endSec - 0.05) {
      await this.run(tools.ffmpeg, buildCutArgs(input, dest, r.startSec, dur, 'exact'), jobId);
      notes.push('구간 안에 키프레임이 없어 재인코딩했습니다.');
    } else if (k - r.startSec <= SMART_MIN_HEAD_SEC) {
      await this.run(tools.ffmpeg, buildCutArgs(input, dest, r.startSec, dur, 'fast'), jobId);
      notes.push('시작 지점이 키프레임이라 재인코딩 없이 복사했습니다.');
    } else {
      const ext = path.extname(dest).slice(1) || 'mkv';
      const head = path.join(tempDir, `head-${String(index)}.${ext}`);
      const tail = path.join(tempDir, `tail-${String(index)}.${ext}`);
      const list = path.join(tempDir, `smart-${String(index)}.txt`);
      await this.run(
        tools.ffmpeg,
        buildCutArgs(input, head, r.startSec, k - r.startSec, 'exact'),
        jobId,
      );
      await this.run(tools.ffmpeg, buildCutArgs(input, tail, k, r.endSec - k, 'fast'), jobId);
      fs.writeFileSync(list, buildConcatListText([head, tail]), 'utf8');
      await this.run(tools.ffmpeg, buildConcatArgs(list, dest), jobId);
      notes.push(
        `스마트 컷: 시작 ${(k - r.startSec).toFixed(2)}초만 재인코딩하고 나머지는 무손실 복사했습니다.`,
      );
    }
    const p = await this.deps.probe.probe(dest, jobId);
    const outDur = p.durationSec.value ?? dur;
    const tol = Math.max(0.5, dur * 0.01);
    if (Math.abs(outDur - dur) > tol) {
      throw new AppError(
        'VALIDATION_FAILED',
        `스마트 컷 결과 ${outDur.toFixed(2)}초, 요청 ${dur.toFixed(2)}초`,
      );
    }
    return { durationSec: outDur, notes };
  }

  private async keyframes(input: string, jobId: string, ffprobe: string): Promise<number[]> {
    const res = await this.deps.proc.run(
      ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'packet=pts_time,flags',
        '-of',
        'csv=p=0',
        input,
      ],
      { captureStdout: true, timeoutMs: CUT_TIMEOUT_MS, jobId: `kf-${jobId}` },
    );
    if (res.exitCode !== 0) throw new AppError('PROBE_FAILED', '키프레임을 읽지 못했습니다');
    return parseKeyframeTimes(res.stdout);
  }

  private async run(ffmpeg: string, args: string[], jobId: string): Promise<void> {
    const res = await this.deps.proc.run(ffmpeg, args, {
      jobId: `cut-${jobId}`,
      timeoutMs: CUT_TIMEOUT_MS,
    });
    if (res.cancelled) throw new AppError('CANCELLED');
    if (res.exitCode !== 0) {
      throw new AppError(
        'ENCODE_FAILED',
        res.stderrTail.slice(-5).join('\n') || `코드 ${String(res.exitCode)}`,
      );
    }
  }
}
