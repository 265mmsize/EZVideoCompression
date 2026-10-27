/**
 * 재생·미리보기 서비스.
 *
 * 미리보기 우선순위 (요구사항 11절)
 *  1) 지원되는 원본 직접 재생: 코덱·컨테이너로 판정하고 전용 프로토콜 URL 을 준다.
 *  2) 정확한 시점의 프레임 추출: 직접 재생이 안 되면 렌더러가 시점별 프레임을 요청한다.
 *  3) 필요한 경우 미리보기 프록시(H.264 ≤1280px ≤10분)를 만든다. 결과는 "변환본"으로 표시하며 압축 결과가 아니다.
 *
 * 설정 미리보기(HandBrake 방식): 작업의 현재 설정으로 짧은 구간을 실제로 인코딩해 보여준다.
 * 이 결과는 previews 테이블에만 기록하고 작업 결과로 저장하지 않는다.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  JobSettings,
  MediaKind,
  MediaRef,
  MediaSource,
  PlaybackCapability,
  PreviewAsset,
  PreviewProgress,
  ProbeResult,
} from '../../../shared/types/domain';
import type { JobRepository } from '../../repositories/JobRepository';
import { toPreviewAsset, type LibraryRepository } from '../../repositories/LibraryRepository';
import type { Logger } from '../../platform/logger';
import { AppError } from '../AppError';
import { buildEncodePlan, passLogPrefixIn } from '../CompressionPolicyService';
import type { FFmpegProcessService } from '../FFmpegProcessService';
import type { ToolPaths } from '../JobRunner';
import type { MediaProbeService } from '../MediaProbeService';
import { ProgressEstimator } from '../ProgressEstimator';
import { MediaTokenRegistry, mimeOf } from './MediaTokenRegistry';
import type { ThumbnailService } from './ThumbnailService';
import { kindOfExtension } from './LibraryIndexer';

/** Electron 44 (Chromium 152) 렌더러에서 canPlayType 이 'probably' 를 돌려준 코덱 (docs/BENCHMARK 3절) */
export const DIRECT_VIDEO_CODECS = ['h264', 'vp8', 'vp9', 'av1'];
export const DIRECT_AUDIO_CODECS = [
  'aac',
  'mp3',
  'opus',
  'vorbis',
  'flac',
  'pcm_s16le',
  'pcm_s24le',
  'pcm_f32le',
];
/** 브라우저가 디코딩하는 이미지 확장자. TIFF 는 변환본으로 표시한다. */
export const DIRECT_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'];

export const PROXY_MAX_SEC = 600;
export const PROXY_MAX_WIDTH = 1280;
export const PROXY_CRF = 28;

export interface ResolvedMedia {
  ref: MediaRef;
  sourceKey: string;
  path: string;
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;
  mediaKind: MediaKind;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  formatName: string | null;
}

export interface PreviewDeps {
  repo: LibraryRepository;
  jobs: JobRepository;
  probe: MediaProbeService;
  proc: FFmpegProcessService;
  tools: () => ToolPaths;
  thumbs: ThumbnailService;
  tokens: MediaTokenRegistry;
  dir: string;
  tempRoot: string;
  logger: Logger;
  emit: (p: PreviewProgress) => void;
  now?: () => Date;
}

/** 코덱·컨테이너 기준의 직접 재생 판정 (순수 함수) */
export function judgeCapability(m: {
  mediaKind: MediaKind;
  path: string;
  videoCodec: string | null;
  audioCodec: string | null;
  formatName: string | null;
}): PlaybackCapability {
  const mime = mimeOf(m.path);
  if (m.mediaKind === 'image') {
    const ext = path.extname(m.path).toLowerCase();
    const direct = DIRECT_IMAGE_EXTENSIONS.includes(ext);
    return {
      direct,
      reason: direct
        ? null
        : `${ext} 이미지는 브라우저가 디코딩하지 못해 표시용 JPEG 변환본을 보여줍니다.`,
      audioPlayable: true,
      mime,
    };
  }
  const codecOk = m.videoCodec !== null && DIRECT_VIDEO_CODECS.includes(m.videoCodec);
  const ext = path.extname(m.path).toLowerCase().replace('.', '');
  const format = m.formatName ?? '';
  // ffprobe 는 MKV 와 WebM 을 모두 "matroska,webm" 으로 보고하므로 확장자를 우선한다. MKV 는 보장하지 않는다.
  const extOk = ['mp4', 'm4v', 'mov', 'webm'].includes(ext);
  const formatOk = format.split(',').some((h) => h === 'mp4' || h === 'mov');
  const containerOk = extOk || (ext !== 'mkv' && formatOk);
  const audioPlayable = m.audioCodec === null || DIRECT_AUDIO_CODECS.includes(m.audioCodec);
  if (!codecOk) {
    return {
      direct: false,
      reason: `${m.videoCodec ?? '알 수 없는'} 코덱은 렌더러가 직접 재생하지 못합니다 (HEVC 는 장치의 하드웨어 디코더에 따라 다릅니다). 프레임 보기 또는 미리보기 변환본을 사용하세요.`,
      audioPlayable,
      mime,
    };
  }
  if (!containerOk) {
    return {
      direct: false,
      reason: `${ext.toUpperCase()} 컨테이너는 직접 재생이 보장되지 않습니다. 프레임 보기 또는 미리보기 변환본을 사용하세요.`,
      audioPlayable,
      mime,
    };
  }
  return {
    direct: true,
    reason: audioPlayable
      ? null
      : `${m.audioCodec ?? ''} 음성은 브라우저에서 재생되지 않아 소리 없이 재생됩니다.`,
    audioPlayable,
    mime,
  };
}

export function sourceKeyOf(ref: MediaRef): string {
  switch (ref.kind) {
    case 'item':
      return `item:${ref.id}`;
    case 'job':
      return `job:${ref.jobId}:${ref.side}`;
    case 'preview':
      return `preview:${ref.id}`;
  }
}

export class PreviewService {
  private readonly running = new Map<string, AbortController>();
  /** 작업 출력 등 DB 에 분석 결과가 없는 파일의 ffprobe 캐시 */
  private readonly probeCache = new Map<string, ProbeResult>();

  constructor(private readonly deps: PreviewDeps) {
    fs.mkdirSync(deps.dir, { recursive: true });
  }

  /** 참조를 실제 파일 정보로 해석한다. 렌더러가 넘긴 경로는 절대 쓰지 않는다. */
  async resolve(ref: MediaRef): Promise<ResolvedMedia> {
    const key = sourceKeyOf(ref);
    if (ref.kind === 'item') {
      const row = this.deps.repo.getItemRow(ref.id);
      if (!row || row.missing === 1) throw new AppError('MEDIA_NOT_FOUND', `item ${ref.id}`);
      return {
        ref,
        sourceKey: key,
        path: row.path,
        fileName: row.file_name,
        sizeBytes: row.size_bytes,
        mtimeMs: row.mtime_ms,
        mediaKind: row.kind,
        durationSec: row.duration_sec,
        width: row.width,
        height: row.height,
        videoCodec: row.video_codec,
        audioCodec: row.audio_codec,
        formatName: row.container,
      };
    }
    if (ref.kind === 'preview') {
      const row = this.deps.repo.getPreview(ref.id);
      if (!row || !fs.existsSync(row.file))
        throw new AppError('MEDIA_NOT_FOUND', `preview ${ref.id}`);
      const probe = await this.probeCached(row.file);
      return this.fromProbe(ref, key, row.file, probe, 'video');
    }
    const job = this.deps.jobs.get(ref.jobId);
    if (!job) throw new AppError('MEDIA_NOT_FOUND', `job ${ref.jobId}`);
    const file = ref.side === 'input' ? job.inputPath : job.outputPath;
    if (!file || !fs.existsSync(file))
      throw new AppError('MEDIA_NOT_FOUND', `${ref.side} of job ${ref.jobId}`);
    const probe = ref.side === 'input' && job.probe ? job.probe : await this.probeCached(file);
    return this.fromProbe(
      ref,
      key,
      file,
      probe,
      kindOfExtension(path.extname(file)) === 'image' ? 'image' : 'video',
    );
  }

  /** 렌더러에 줄 재생 소스. TIFF 처럼 직접 표시가 안 되는 이미지는 변환본 URL 을 돌려준다. */
  async source(ref: MediaRef): Promise<MediaSource> {
    const m = await this.resolve(ref);
    const capability = judgeCapability(m);
    let url: string;
    if (m.mediaKind === 'image' && !capability.direct) {
      const converted = await this.deps.thumbs.fullImage(toInfo(m));
      url = this.deps.tokens.issue(`full:${m.sourceKey}`, converted, 'image/jpeg');
      capability.direct = true; // 변환본은 JPEG 이므로 표시 가능. reason 에 변환 사실이 남아 있다.
    } else {
      url = this.deps.tokens.issue(`src:${m.sourceKey}`, m.path);
    }
    return {
      ref,
      url,
      capability,
      mediaKind: m.mediaKind,
      durationSec: m.durationSec,
      width: m.width,
      height: m.height,
      sizeBytes: m.sizeBytes,
      fileName: m.fileName,
    };
  }

  async frame(ref: MediaRef, timeSec: number): Promise<{ url: string; timeSec: number }> {
    const m = await this.resolve(ref);
    if (m.mediaKind !== 'video')
      throw new AppError('INVALID_REQUEST', '영상만 프레임을 추출할 수 있습니다');
    const t = Math.max(0, Math.min(timeSec, Math.max(0, (m.durationSec ?? timeSec) - 0.05)));
    const file = await this.deps.thumbs.frame(toInfo(m), t);
    const rounded = Math.round(t * 10) / 10;
    return {
      url: this.deps.tokens.issue(`frame:${m.sourceKey}:${rounded.toFixed(1)}`, file, 'image/jpeg'),
      timeSec: rounded,
    };
  }

  /** 미리보기 프록시 생성 시작. 진행은 이벤트로 알린다. */
  async createProxy(itemId: string): Promise<string> {
    const m = await this.resolve({ kind: 'item', id: itemId });
    if (m.mediaKind !== 'video')
      throw new AppError('INVALID_REQUEST', '영상만 변환본을 만들 수 있습니다');
    const existing = this.deps.repo
      .listPreviews(m.sourceKey)
      .find((p) => p.kind === 'proxy' && fs.existsSync(p.file));
    if (existing) {
      this.deps.emit({
        previewId: existing.id,
        status: 'done',
        ratio: 1,
        asset: this.asset(existing),
        error: null,
      });
      return existing.id;
    }
    const id = randomUUID();
    const out = path.join(this.deps.dir, `${id}.mp4`);
    const audioArgs = m.audioCodec
      ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k', '-ac', '2']
      : ['-an'];
    const args = [
      '-n',
      '-hide_banner',
      '-loglevel',
      'warning',
      '-nostats',
      '-nostdin',
      '-progress',
      'pipe:1',
      '-i',
      m.path,
      '-map',
      '0:v:0',
      ...audioArgs,
      '-sn',
      '-dn',
      '-t',
      String(PROXY_MAX_SEC),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      String(PROXY_CRF),
      '-vf',
      `scale='min(${String(PROXY_MAX_WIDTH)},iw)':-2`,
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      out,
    ];
    const note = `미리보기용 변환본 (H.264, 최대 ${String(PROXY_MAX_WIDTH)}px, 최대 ${String(PROXY_MAX_SEC / 60)}분). 압축 결과가 아닙니다.`;
    const durationSec = m.durationSec === null ? null : Math.min(m.durationSec, PROXY_MAX_SEC);
    this.start(id, 'proxy', m.sourceKey, out, args, {
      durationSec,
      settings: null,
      startSec: null,
      note,
    });
    return id;
  }

  /** 설정 미리보기: 작업의 현재 설정으로 [startSec, startSec+durationSec] 구간을 실제 인코딩한다 */
  createSettingsPreview(jobId: string, startSec: number, durationSec: number): string {
    const job = this.deps.jobs.get(jobId);
    if (!job?.probe || !job.analysis)
      throw new AppError('INVALID_STATE', '분석이 끝난 작업만 미리볼 수 있습니다');
    if (job.analysis.support === 'blocked')
      throw new AppError('UNSUPPORTED_SETTINGS', '차단된 설정은 미리볼 수 없습니다');
    if (job.settings.mode === 'copy')
      throw new AppError(
        'INVALID_REQUEST',
        '원본 유지 모드는 재인코딩하지 않으므로 설정 미리보기가 필요 없습니다',
      );
    const total = job.probe.durationSec.value;
    if (total !== null && startSec >= total)
      throw new AppError('INVALID_REQUEST', '시작 시점이 영상 길이를 넘습니다');
    const dur =
      total === null ? durationSec : Math.min(durationSec, Math.max(0.5, total - startSec));
    const id = randomUUID();
    const out = path.join(this.deps.dir, `${id}.${job.settings.container}`);
    const tempDir = path.join(this.deps.tempRoot, `preview-${id}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const plan = buildEncodePlan(job.probe, job.settings, job.analysis, {
      inputPath: job.inputPath,
      outputPath: out,
      passLogPrefix: passLogPrefixIn(tempDir),
      nullSink: process.platform === 'win32' ? 'NUL' : '/dev/null',
      hardwareEncoder: null,
      inputTrim: { startSec, durationSec: dur },
    });
    const note = `설정 미리보기 (${plan.encoderLabel}, ${startSec.toFixed(1)}초부터 ${dur.toFixed(1)}초). 압축 결과로 저장되지 않습니다.`;
    this.startPasses(id, 'settings', `job:${jobId}`, out, plan.passes, {
      durationSec: dur,
      settings: job.settings,
      startSec,
      note,
      cleanupDir: tempDir,
    });
    return id;
  }

  cancel(previewId: string): boolean {
    const c = this.running.get(previewId);
    if (!c) return false;
    c.abort();
    return true;
  }

  list(sourceKey: string): PreviewAsset[] {
    return this.deps.repo
      .listPreviews(sourceKey)
      .filter((p) => fs.existsSync(p.file))
      .map((p) => this.asset(p));
  }

  remove(previewId: string): boolean {
    const row = this.deps.repo.getPreview(previewId);
    if (!row) return false;
    fs.rmSync(row.file, { force: true });
    this.deps.tokens.revokePrefix(`src:preview:${previewId}`);
    return this.deps.repo.deletePreview(previewId);
  }

  stats(): { bytes: number; count: number } {
    return this.deps.repo.previewStats();
  }

  clear(): void {
    for (const p of this.deps.repo.allPreviews()) this.remove(p.id);
  }

  shutdown(): void {
    for (const c of this.running.values()) c.abort();
  }

  // -------------------------------------------------------------------------

  private asset(row: Parameters<typeof toPreviewAsset>[0]): PreviewAsset {
    return toPreviewAsset(row, this.deps.tokens.issue(`src:preview:${row.id}`, row.file));
  }

  private start(
    id: string,
    kind: 'proxy' | 'settings',
    sourceKey: string,
    out: string,
    args: string[],
    meta: {
      durationSec: number | null;
      settings: JobSettings | null;
      startSec: number | null;
      note: string;
    },
  ): void {
    this.startPasses(id, kind, sourceKey, out, [args], { ...meta, cleanupDir: null });
  }

  private startPasses(
    id: string,
    kind: 'proxy' | 'settings',
    sourceKey: string,
    out: string,
    passes: string[][],
    meta: {
      durationSec: number | null;
      settings: JobSettings | null;
      startSec: number | null;
      note: string;
      cleanupDir: string | null;
    },
  ): void {
    const controller = new AbortController();
    this.running.set(id, controller);
    this.deps.emit({ previewId: id, status: 'running', ratio: null, asset: null, error: null });
    void (async () => {
      try {
        const tools = this.deps.tools();
        for (const [i, args] of passes.entries()) {
          const est = new ProgressEstimator(meta.durationSec, Date.now());
          const res = await this.deps.proc.run(tools.ffmpeg, args, {
            jobId: `preview-${id}`,
            signal: controller.signal,
            stallTimeoutMs: 5 * 60_000,
            onProgress: (s) => {
              const snap = est.update(s.outTimeSec, s.speed, Date.now(), {
                index: i,
                count: passes.length,
              });
              this.deps.emit({
                previewId: id,
                status: 'running',
                ratio: snap.ratio,
                asset: null,
                error: null,
              });
            },
          });
          if (res.cancelled) throw new AppError('CANCELLED');
          if (res.exitCode !== 0) {
            throw new AppError(
              'PREVIEW_FAILED',
              res.stderrTail.slice(-10).join('\n') || `코드 ${String(res.exitCode)}`,
            );
          }
        }
        const bytes = fs.statSync(out).size;
        this.deps.repo.insertPreview({
          id,
          kind,
          sourceKey,
          file: out,
          bytes,
          durationSec: meta.durationSec,
          settings: meta.settings,
          startSec: meta.startSec,
          note: meta.note,
          at: this.now(),
        });
        const row = this.deps.repo.getPreview(id);
        this.deps.emit({
          previewId: id,
          status: 'done',
          ratio: 1,
          asset: row ? this.asset(row) : null,
          error: null,
        });
      } catch (err) {
        const app = AppError.from(err);
        fs.rmSync(out, { force: true });
        const status = app.code === 'CANCELLED' ? 'cancelled' : 'failed';
        if (status === 'failed')
          this.deps.logger.warn('preview failed', { previewId: id, detail: app.detail });
        this.deps.emit({
          previewId: id,
          status,
          ratio: null,
          asset: null,
          error: app.detail ?? app.code,
        });
      } finally {
        this.running.delete(id);
        if (meta.cleanupDir) fs.rmSync(meta.cleanupDir, { recursive: true, force: true });
      }
    })();
  }

  private async probeCached(file: string): Promise<ProbeResult> {
    const st = fs.statSync(file);
    const key = `${file}|${String(st.size)}|${String(Math.floor(st.mtimeMs))}`;
    const hit = this.probeCache.get(key);
    if (hit) return hit;
    const probe = await this.deps.probe.probe(file);
    this.probeCache.set(key, probe);
    if (this.probeCache.size > 200)
      this.probeCache.delete(this.probeCache.keys().next().value as string);
    return probe;
  }

  private fromProbe(
    ref: MediaRef,
    sourceKey: string,
    file: string,
    probe: ProbeResult,
    mediaKind: MediaKind,
  ): ResolvedMedia {
    const video = probe.streams.find((s) => s.kind === 'video' && !s.isAttachedPic) ?? null;
    const audio = probe.streams.find((s) => s.kind === 'audio') ?? null;
    const st = fs.statSync(file);
    return {
      ref,
      sourceKey,
      path: file,
      fileName: path.basename(file),
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      mediaKind,
      durationSec: mediaKind === 'video' ? probe.durationSec.value : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      videoCodec: video?.codecName ?? null,
      audioCodec: audio?.codecName ?? null,
      formatName: probe.formatName,
    };
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }
}

function toInfo(m: ResolvedMedia): {
  path: string;
  kind: MediaKind;
  sizeBytes: number;
  mtimeMs: number;
  durationSec: number | null;
} {
  return {
    path: m.path,
    kind: m.mediaKind,
    sizeBytes: m.sizeBytes,
    mtimeMs: m.mtimeMs,
    durationSec: m.durationSec,
  };
}
