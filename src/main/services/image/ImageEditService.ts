/**
 * 이미지 편집: 자르기·회전·뒤집기·미세 회전·크기 조정·화질 보정을 FFmpeg 필터 체인으로 적용한다.
 *
 * 원칙
 * - 원본은 읽기만 한다. 결과는 임시 파일(.vslim-tmp-)에 만들고 ffprobe 로 확인한 뒤 새 이름으로 확정한다.
 *   이름이 겹치면 " (2)" 번호를 붙이고 절대 덮어쓰지 않는다.
 * - 미리보기는 축소본(JPEG)이며 저장 결과와 같은 필터 체인을 쓴다. 저장 결과 해상도는 계산값으로 함께 돌려준다.
 * - "화질 보정"은 선명화·노이즈 제거·밝기/대비/채도/감마·자동 레벨뿐이다. AI 복원이 아니며 없는 세부 정보를 만들지 않는다.
 * - EXIF 등 메타데이터는 FFmpeg 의 이미지 출력이 보존하지 않는다. 결과 notes 에 명시한다.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ImageEditOps,
  ImageExportFormat,
  ImageExportRequest,
  ImageExportResult,
  ImageInfo,
  ImagePreview,
} from '../../../shared/types/domain';
import { AppError } from '../AppError';
import type { FFmpegProcessService } from '../FFmpegProcessService';
import {
  finalizeFile,
  isSamePath,
  removeAppTempFile,
  resolveFinalPath,
  tempOutputPath,
} from '../FileFinalizeService';
import type { ToolPaths } from '../JobRunner';
import type { MediaProbeService } from '../MediaProbeService';
import type { MediaTokenRegistry } from '../library/MediaTokenRegistry';
import type { ThumbnailService } from '../library/ThumbnailService';
import type { Logger } from '../../platform/logger';

export const DEFAULT_OPS: ImageEditOps = {
  crop: null,
  rotate: 0,
  flipH: false,
  flipV: false,
  angle: 0,
  fillColor: '#ffffff',
  resize: null,
  enhance: {
    sharpen: 0,
    denoise: 0,
    brightness: 0,
    contrast: 1,
    saturation: 1,
    gamma: 1,
    autoLevel: false,
  },
};

/** 브라우저(Chromium)가 직접 표시할 수 있는 이미지 코덱 */
const BROWSER_IMAGE_CODECS = ['mjpeg', 'png', 'webp', 'gif', 'bmp', 'av1'];
const ALPHA_PIX_FMTS = /a$|^ya|argb|abgr|rgba|bgra|gbrap|yuva|pal8/;
const PREVIEW_KEEP = 40;
const CALL_TIMEOUT_MS = 120_000;

export interface SizeWH {
  width: number;
  height: number;
}

/** 편집 후 결과 해상도 (저장 시 실제 해상도와 같아야 한다. 검증에 쓴다) */
export function predictOutputSize(src: SizeWH, ops: ImageEditOps): SizeWH {
  let w = src.width;
  let h = src.height;
  if (ops.crop) {
    const c = clampCrop(ops.crop, src);
    w = c.width;
    h = c.height;
  }
  if (ops.rotate === 90 || ops.rotate === 270) [w, h] = [h, w];
  if (ops.angle !== 0) {
    const a = (Math.abs(ops.angle) * Math.PI) / 180;
    // rotw/roth 와 같은 계산. FFmpeg rotate 필터는 식 결과에 0.5 를 더해 정수로 자른다 (반올림).
    const rw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
    const rh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    w = Math.floor(rw + 0.5);
    h = Math.floor(rh + 0.5);
  }
  if (ops.resize) {
    w = ops.resize.width;
    h = ops.resize.height;
  }
  return { width: Math.max(1, w), height: Math.max(1, h) };
}

/** 자르기 영역을 원본 안으로 맞춘다 (화면에서 넘긴 값이 경계를 살짝 넘을 수 있다) */
export function clampCrop(crop: ImageEditOps['crop'] & object, src: SizeWH): ImageCropLike {
  const x = Math.min(Math.max(0, Math.round(crop.x)), src.width - 1);
  const y = Math.min(Math.max(0, Math.round(crop.y)), src.height - 1);
  const width = Math.max(1, Math.min(Math.round(crop.width), src.width - x));
  const height = Math.max(1, Math.min(Math.round(crop.height), src.height - y));
  return { x, y, width, height };
}

interface ImageCropLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 편집 연산이 모두 기본값인지 (원본과 같은 결과) */
export function isIdentity(ops: ImageEditOps): boolean {
  const e = ops.enhance;
  return (
    ops.crop === null &&
    ops.rotate === 0 &&
    !ops.flipH &&
    !ops.flipV &&
    ops.angle === 0 &&
    ops.resize === null &&
    e.sharpen === 0 &&
    e.denoise === 0 &&
    e.brightness === 0 &&
    e.contrast === 1 &&
    e.saturation === 1 &&
    e.gamma === 1 &&
    !e.autoLevel
  );
}

/**
 * FFmpeg -vf 필터 체인. 순수 함수.
 * 순서: crop → transpose/flip → rotate(미세) → scale → 자동 레벨 → eq → hqdn3d → unsharp
 */
export function buildImageFilterChain(src: SizeWH, ops: ImageEditOps): string[] {
  const f: string[] = [];
  if (ops.crop) {
    const c = clampCrop(ops.crop, src);
    f.push(`crop=${String(c.width)}:${String(c.height)}:${String(c.x)}:${String(c.y)}`);
  }
  // transpose=1: 시계 방향 90°, transpose=2: 반시계 90°
  if (ops.rotate === 90) f.push('transpose=1');
  else if (ops.rotate === 270) f.push('transpose=2');
  else if (ops.rotate === 180) f.push('transpose=1', 'transpose=1');
  if (ops.flipH) f.push('hflip');
  if (ops.flipV) f.push('vflip');
  if (ops.angle !== 0) {
    const rad = ((ops.angle * Math.PI) / 180).toFixed(6);
    // ow/oh 를 회전된 전체가 들어가는 크기로 키우고 빈 곳은 fillColor 로 채운다
    f.push(`rotate=${rad}:ow=rotw(${rad}):oh=roth(${rad}):c=${ffColor(ops.fillColor)}`);
  }
  if (ops.resize) {
    f.push(
      `scale=${String(ops.resize.width)}:${String(ops.resize.height)}:flags=${ops.resize.filter}`,
    );
  }
  const e = ops.enhance;
  if (e.autoLevel) f.push('normalize=smoothing=0');
  if (e.brightness !== 0 || e.contrast !== 1 || e.saturation !== 1 || e.gamma !== 1) {
    f.push(
      `eq=brightness=${e.brightness.toFixed(3)}:contrast=${e.contrast.toFixed(3)}:saturation=${e.saturation.toFixed(3)}:gamma=${e.gamma.toFixed(3)}`,
    );
  }
  if (e.denoise > 0) {
    const s = e.denoise.toFixed(2);
    f.push(`hqdn3d=${s}:${s}:0:0`);
  }
  if (e.sharpen > 0) f.push(`unsharp=5:5:${e.sharpen.toFixed(2)}:5:5:0`);
  return f;
}

/** '#rrggbb' → FFmpeg 색 표기 '0xRRGGBB' */
export function ffColor(hex: string): string {
  return `0x${hex.slice(1).toUpperCase()}`;
}

export type ConcreteFormat = Exclude<ImageExportFormat, 'keep'>;

/** 'keep' 을 원본 코덱에 맞는 실제 형식으로 바꾼다. 알 수 없는 형식(TIFF, BMP 등)은 PNG 로 저장한다 */
export function resolveFormat(format: ImageExportFormat, sourceCodec: string): ConcreteFormat {
  if (format !== 'keep') return format;
  if (sourceCodec === 'mjpeg') return 'jpeg';
  if (sourceCodec === 'webp') return 'webp';
  return 'png';
}

export const FORMAT_EXT: Readonly<Record<ConcreteFormat, string>> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
};

/** 저장 형식별 인코더 인자. JPEG 는 90 이상이면 4:4:4 로 색 해상도를 유지한다. */
export function formatArgs(format: ConcreteFormat, quality: number, hasAlpha: boolean): string[] {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  switch (format) {
    case 'jpeg': {
      // mjpeg 의 -q:v 는 2(최고)~31(최저). 100 → 2, 1 → 31 로 선형 변환
      const qv = Math.round(31 - ((q - 1) / 99) * 29);
      return ['-c:v', 'mjpeg', '-q:v', String(qv), '-pix_fmt', q >= 90 ? 'yuvj444p' : 'yuvj420p'];
    }
    case 'png':
      return ['-c:v', 'png', '-pix_fmt', hasAlpha ? 'rgba' : 'rgb24', '-compression_level', '6'];
    case 'webp':
      return [
        '-c:v',
        'libwebp',
        '-quality',
        String(q),
        '-compression_level',
        '4',
        '-pix_fmt',
        hasAlpha ? 'yuva420p' : 'yuv420p',
      ];
  }
}

export interface ImageEditDeps {
  proc: FFmpegProcessService;
  probe: MediaProbeService;
  tools: () => ToolPaths;
  tokens: MediaTokenRegistry;
  thumbs: ThumbnailService;
  /** 미리보기 파일 디렉터리 (userData/edit-previews) */
  previewDir: string;
  logger: Logger;
  /** 결과를 라이브러리에 반영 (등록 폴더 밖이면 null) */
  indexFile: (filePath: string) => Promise<string | null>;
}

export class ImageEditService {
  /** 경로별 진행 중인 미리보기. 새 요청이 오면 이전 것을 중단한다 */
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly deps: ImageEditDeps) {
    fs.mkdirSync(deps.previewDir, { recursive: true });
  }

  async open(filePath: string): Promise<ImageInfo> {
    const probe = await this.deps.probe.probe(filePath);
    const v = probe.streams.find((s) => s.kind === 'video');
    if (!v || v.width === null || v.height === null) {
      throw new AppError('UNSUPPORTED_INPUT', '이미지 스트림을 찾을 수 없습니다');
    }
    const pixFmt = v.pixFmt;
    const hasAlpha = pixFmt !== null && ALPHA_PIX_FMTS.test(pixFmt);
    const direct = BROWSER_IMAGE_CODECS.includes(v.codecName);
    const key = `edit:src:${probe.path}`;
    let url: string;
    if (direct) {
      url = this.deps.tokens.issue(key, probe.path, mimeOf(v.codecName));
    } else {
      const file = await this.deps.thumbs.fullImage({
        path: probe.path,
        kind: 'image',
        sizeBytes: probe.sizeBytes,
        mtimeMs: probe.mtimeMs,
        durationSec: null,
      });
      url = this.deps.tokens.issue(key, file, 'image/jpeg');
    }
    return {
      path: probe.path,
      fileName: probe.fileName,
      width: v.width,
      height: v.height,
      sizeBytes: probe.sizeBytes,
      mtimeMs: probe.mtimeMs,
      codec: v.codecName,
      pixFmt,
      hasAlpha,
      url,
      converted: !direct,
    };
  }

  /** 편집 미리보기. 결과 해상도는 저장 기준이고 이미지는 maxWidth 이하 축소본이다 */
  async preview(filePath: string, ops: ImageEditOps, maxWidth: number): Promise<ImagePreview> {
    const info = await this.open(filePath);
    const src = { width: info.width, height: info.height };
    const full = predictOutputSize(src, ops);
    const scale = Math.min(1, maxWidth / full.width);
    const pw = Math.max(1, Math.round(full.width * scale));
    const ph = Math.max(1, Math.round(full.height * scale));

    this.inflight.get(filePath)?.abort();
    const controller = new AbortController();
    this.inflight.set(filePath, controller);

    const out = path.join(this.deps.previewDir, `${randomUUID()}.jpg`);
    const chain = [...buildImageFilterChain(src, ops), `scale=${String(pw)}:${String(ph)}`];
    const tools = this.deps.tools();
    const res = await this.deps.proc.run(
      tools.ffmpeg,
      [
        ...COMMON_IN,
        '-i',
        filePath,
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-vf',
        chain.join(','),
        '-pix_fmt',
        'yuvj420p',
        '-q:v',
        '3',
        '-update',
        '1',
        '-f',
        'image2',
        out,
      ],
      { timeoutMs: CALL_TIMEOUT_MS, signal: controller.signal },
    );
    if (this.inflight.get(filePath) === controller) this.inflight.delete(filePath);
    if (controller.signal.aborted) {
      fs.rmSync(out, { force: true });
      throw new AppError('CANCELLED', '새 미리보기 요청으로 대체되었습니다');
    }
    if (res.exitCode !== 0 || !fs.existsSync(out)) {
      fs.rmSync(out, { force: true });
      throw new AppError('IMAGE_EDIT_FAILED', res.stderrTail.slice(-3).join('\n'));
    }
    this.trimPreviews();
    return {
      url: this.deps.tokens.issue(`edit:preview:${path.basename(out)}`, out, 'image/jpeg'),
      width: full.width,
      height: full.height,
      previewWidth: pw,
      previewHeight: ph,
    };
  }

  /** 전체 크기 저장. 임시 파일 → ffprobe 검증 → 새 이름으로 확정 */
  async exportImage(req: ImageExportRequest): Promise<ImageExportResult> {
    const info = await this.open(req.path);
    const src = { width: info.width, height: info.height };
    const format = resolveFormat(req.format, info.codec);
    const ext = FORMAT_EXT[format];
    const expected = predictOutputSize(src, req.ops);
    const notes: string[] = ['EXIF 등 원본 메타데이터는 결과에 복사되지 않습니다.'];
    if (info.hasAlpha && format === 'jpeg')
      notes.push('JPEG 는 투명도를 지원하지 않아 알파 채널이 제거됩니다.');
    if (isIdentity(req.ops) && format === resolveFormat('keep', info.codec)) {
      notes.push('편집 내용이 없어 원본을 다시 인코딩한 결과입니다.');
    }

    let outDir: string;
    let baseName: string;
    if (req.target.kind === 'suffix') {
      outDir = path.dirname(req.path);
      baseName = path.parse(req.path).name + req.target.suffix;
    } else {
      outDir = path.dirname(req.target.path);
      baseName = path.parse(req.target.path).name;
    }
    if (!fs.existsSync(outDir)) throw new AppError('INVALID_REQUEST', `폴더가 없습니다: ${outDir}`);

    const id = randomUUID();
    const temp = tempOutputPath(outDir, baseName, id, ext);
    if (isSamePath(temp, req.path))
      throw new AppError('OUTPUT_PATH_CONFLICT', '임시 경로가 원본과 같습니다');
    const chain = buildImageFilterChain(src, req.ops);
    const tools = this.deps.tools();
    const args = [...COMMON_IN, '-i', req.path, '-map', '0:v:0', '-frames:v', '1'];
    if (chain.length > 0) args.push('-vf', chain.join(','));
    args.push(
      ...formatArgs(format, req.quality, info.hasAlpha),
      '-update',
      '1',
      '-f',
      'image2',
      temp,
    );
    try {
      const res = await this.deps.proc.run(tools.ffmpeg, args, { timeoutMs: CALL_TIMEOUT_MS });
      if (res.exitCode !== 0 || !fs.existsSync(temp)) {
        throw new AppError('IMAGE_EDIT_FAILED', res.stderrTail.slice(-3).join('\n'));
      }
      // 검증: 결과를 다시 읽어 해상도가 계산값과 같은지 확인한다
      const outProbe = await this.deps.probe.probe(temp);
      const ov = outProbe.streams.find((s) => s.kind === 'video');
      if (!ov || ov.width !== expected.width || ov.height !== expected.height) {
        throw new AppError(
          'VALIDATION_FAILED',
          `결과 해상도 ${String(ov?.width)}×${String(ov?.height)}, 기대 ${String(expected.width)}×${String(expected.height)}`,
        );
      }
      const finalPath = resolveFinalPath(outDir, baseName, ext, req.path);
      finalizeFile(temp, finalPath);
      const sizeBytes = fs.statSync(finalPath).size;
      let libraryItemId: string | null = null;
      try {
        libraryItemId = await this.deps.indexFile(finalPath);
      } catch (err) {
        this.deps.logger.warn('indexing edited image failed', { finalPath, err: String(err) });
      }
      this.deps.logger.info('image exported', { source: req.path, finalPath, format, sizeBytes });
      return {
        outputPath: finalPath,
        width: expected.width,
        height: expected.height,
        sizeBytes,
        format,
        libraryItemId,
        notes,
      };
    } finally {
      removeAppTempFile(temp);
    }
  }

  /** 미리보기 파일은 최근 것만 남긴다 */
  private trimPreviews(): void {
    try {
      const files = fs
        .readdirSync(this.deps.previewDir)
        .filter((n) => n.endsWith('.jpg'))
        .map((n) => {
          const p = path.join(this.deps.previewDir, n);
          return { p, t: fs.statSync(p).mtimeMs };
        })
        .sort((a, b) => b.t - a.t);
      for (const f of files.slice(PREVIEW_KEEP)) fs.rmSync(f.p, { force: true });
    } catch {
      // 정리 실패는 무시한다 (다음 호출에서 다시 시도)
    }
  }

  clear(): void {
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
    fs.rmSync(this.deps.previewDir, { recursive: true, force: true });
    fs.mkdirSync(this.deps.previewDir, { recursive: true });
  }
}

const COMMON_IN = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];

function mimeOf(codec: string): string {
  switch (codec) {
    case 'mjpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'bmp':
      return 'image/bmp';
    case 'av1':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}
