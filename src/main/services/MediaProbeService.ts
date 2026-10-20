/**
 * ffprobe 기반 영상 분석.
 *
 * 설계 원칙:
 * - 확장자로 판단하지 않는다. ffprobe 가 읽은 실제 스트림 정보만 사용한다.
 * - 값이 없으면 추측하지 않고 MeasuredValue 의 source 를 'unknown' 으로 둔다.
 * - 평균(avg)과 명목(r) 프레임레이트가 다르다는 이유만으로 VFR 을 확정하지 않는다.
 *   실제 타임스탬프 확인은 필요할 때 별도 함수(analyzeFrameTiming)에서 수행한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  MeasuredValue,
  ProbeChapter,
  ProbeResult,
  ProbeStream,
  StreamKind,
} from '../../shared/types/domain';
import { AppError } from './AppError';
import type { FFmpegProcessService } from './FFmpegProcessService';

// ---------------------------------------------------------------------------
// ffprobe JSON 의 필요한 부분만 표현한 타입
// ---------------------------------------------------------------------------

export interface RawStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  codec_long_name?: string;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  width?: number;
  height?: number;
  field_order?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  time_base?: string;
  start_time?: string;
  duration?: string;
  bit_rate?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  color_space?: string;
  color_range?: string;
  color_transfer?: string;
  color_primaries?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
}

export interface RawProbe {
  streams?: RawStream[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
    size?: string;
  };
  chapters?: { start_time?: string; end_time?: string; tags?: Record<string, string> }[];
}

// ---------------------------------------------------------------------------
// 순수 파싱 함수 (테스트 가능)
// ---------------------------------------------------------------------------

const UNKNOWN_NUM: MeasuredValue<number> = { value: null, source: 'unknown' };

function confirmed(v: number | null): MeasuredValue<number> {
  return v === null || !Number.isFinite(v) ? UNKNOWN_NUM : { value: v, source: 'confirmed' };
}

/** "30000/1001" 같은 분수 문자열을 숫자로. 0/0 이나 잘못된 값은 null. */
export function parseRational(text: string | undefined): number | null {
  if (!text) return null;
  const m = /^(-?\d+)\/(\d+)$/.exec(text.trim());
  if (m) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (den === 0) return null;
    const v = num / den;
    return v > 0 ? v : null;
  }
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function kindOf(codecType: string | undefined): StreamKind {
  switch (codecType) {
    case 'video':
    case 'audio':
    case 'subtitle':
    case 'attachment':
    case 'data':
      return codecType;
    default:
      return 'unknown';
  }
}

/** pix_fmt 이름에서 비트 심도를 추정한다. ffprobe 의 bits_per_raw_sample 이 있으면 그 값을 우선한다. */
export function bitDepthFromPixFmt(
  pixFmt: string | null,
  bitsPerRaw: string | undefined,
): number | null {
  const raw = bitsPerRaw ? Number(bitsPerRaw) : NaN;
  if (Number.isFinite(raw) && raw > 0) return raw;
  if (!pixFmt) return null;
  const m = /(\d{2})(le|be)?$/.exec(pixFmt);
  if (m) {
    const n = Number(m[1]);
    if (n === 10 || n === 12 || n === 16) return n;
  }
  if (/^(yuv|rgb|gray|nv12|p0|bgr|argb|rgba|bgra|yuva)/.test(pixFmt)) return 8;
  return null;
}

export function hasAlphaPixFmt(pixFmt: string | null): boolean {
  if (!pixFmt) return false;
  return /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(pixFmt);
}

/** 회전 정보는 side_data(Display Matrix) 의 rotation 또는 tags.rotate 에서 가져온다. */
export function rotationOf(s: RawStream): number {
  const fromSide = s.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  const raw = fromSide ?? (s.tags?.['rotate'] ? Number(s.tags['rotate']) : 0);
  if (!Number.isFinite(raw)) return 0;
  const norm = ((Math.round(raw) % 360) + 360) % 360;
  // 회전 표현은 시계 반대 방향이든 시계 방향이든 90 단위 값만 의미가 있다.
  return [0, 90, 180, 270].includes(norm) ? norm : 0;
}

function hasDolbyVision(s: RawStream): boolean {
  return (s.side_data_list ?? []).some((d) => /dovi|dolby vision/i.test(d.side_data_type ?? ''));
}

export function parseStream(s: RawStream, formatDurationSec: number | null): ProbeStream {
  const kind = kindOf(s.codec_type);
  const isVideo = kind === 'video';
  const pixFmt = s.pix_fmt ?? null;
  const avg = parseRational(s.avg_frame_rate);
  const nominal = parseRational(s.r_frame_rate);

  // 스트림 자체 길이가 없으면 컨테이너 길이를 "추정" 값으로만 사용한다.
  const streamDur = s.duration !== undefined ? Number(s.duration) : NaN;
  let durationSec: MeasuredValue<number>;
  if (Number.isFinite(streamDur) && streamDur > 0) durationSec = confirmed(streamDur);
  else if (formatDurationSec !== null)
    durationSec = { value: formatDurationSec, source: 'estimated' };
  else durationSec = UNKNOWN_NUM;

  const br = s.bit_rate !== undefined ? Number(s.bit_rate) : NaN;

  const fieldOrder: ProbeStream['fieldOrder'] =
    !s.field_order || s.field_order === 'unknown'
      ? 'unknown'
      : s.field_order === 'progressive'
        ? 'progressive'
        : 'interlaced';

  return {
    index: s.index,
    kind,
    codecName: s.codec_name ?? 'unknown',
    codecLongName: s.codec_long_name ?? null,
    language: s.tags?.['language'] ?? null,
    title: s.tags?.['title'] ?? null,
    isDefault: (s.disposition?.['default'] ?? 0) === 1,
    isAttachedPic: (s.disposition?.['attached_pic'] ?? 0) === 1,
    width: isVideo ? (s.width ?? null) : null,
    height: isVideo ? (s.height ?? null) : null,
    pixFmt: isVideo ? pixFmt : null,
    bitDepth: isVideo ? bitDepthFromPixFmt(pixFmt, s.bits_per_raw_sample) : null,
    hasAlpha: isVideo && hasAlphaPixFmt(pixFmt),
    fieldOrder: isVideo ? fieldOrder : 'unknown',
    avgFrameRate: isVideo ? confirmed(avg) : UNKNOWN_NUM,
    nominalFrameRate: isVideo ? confirmed(nominal) : UNKNOWN_NUM,
    rotation: isVideo ? rotationOf(s) : 0,
    colorSpace: isVideo ? (s.color_space ?? null) : null,
    colorRange: isVideo ? (s.color_range ?? null) : null,
    colorTransfer: isVideo ? (s.color_transfer ?? null) : null,
    colorPrimaries: isVideo ? (s.color_primaries ?? null) : null,
    hasDolbyVision: isVideo && hasDolbyVision(s),
    bitRate: Number.isFinite(br) && br > 0 ? confirmed(br) : UNKNOWN_NUM,
    channels: kind === 'audio' ? (s.channels ?? null) : null,
    channelLayout: kind === 'audio' ? (s.channel_layout ?? null) : null,
    sampleRate: kind === 'audio' && s.sample_rate ? Number(s.sample_rate) : null,
    durationSec,
    startTimeSec:
      s.start_time !== undefined && Number.isFinite(Number(s.start_time))
        ? Number(s.start_time)
        : null,
    timeBase: s.time_base ?? null,
    disposition: s.disposition ?? {},
  };
}

export function parseProbeJson(
  raw: RawProbe,
  file: { path: string; sizeBytes: number; mtimeMs: number },
): ProbeResult {
  const formatDur = raw.format?.duration !== undefined ? Number(raw.format.duration) : NaN;
  const formatDurationSec = Number.isFinite(formatDur) && formatDur > 0 ? formatDur : null;
  const formatBr = raw.format?.bit_rate !== undefined ? Number(raw.format.bit_rate) : NaN;

  const streams = (raw.streams ?? []).map((s) => parseStream(s, formatDurationSec));
  const chapters: ProbeChapter[] = (raw.chapters ?? []).map((c) => ({
    startSec: Number(c.start_time ?? 0),
    endSec: Number(c.end_time ?? 0),
    title: c.tags?.['title'] ?? null,
  }));

  return {
    path: file.path,
    fileName: path.basename(file.path),
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    formatName: raw.format?.format_name ?? 'unknown',
    durationSec: formatDurationSec !== null ? confirmed(formatDurationSec) : UNKNOWN_NUM,
    bitRate: Number.isFinite(formatBr) && formatBr > 0 ? confirmed(formatBr) : UNKNOWN_NUM,
    streams,
    chapters,
  };
}

// ---------------------------------------------------------------------------
// 서비스
// ---------------------------------------------------------------------------

export class MediaProbeService {
  constructor(
    private readonly proc: FFmpegProcessService,
    private readonly getFfprobePath: () => string,
  ) {}

  async probe(filePath: string, jobId?: string): Promise<ProbeResult> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      throw new AppError('INPUT_MISSING', filePath, { cause: err });
    }
    if (!stat.isFile()) throw new AppError('INPUT_UNREADABLE', `파일이 아님: ${filePath}`);

    const res = await this.proc.run(
      this.getFfprobePath(),
      [
        '-hide_banner',
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-show_chapters',
        // 입력 경로가 "-" 나 "-"로 시작하는 경우에도 옵션으로 해석되지 않도록 -i 로 명시한다.
        '-i',
        filePath,
      ],
      { timeoutMs: 60_000, captureStdout: true, jobId },
    );

    if (res.timedOut) throw new AppError('PROBE_TIMEOUT', filePath);
    if (res.exitCode !== 0) {
      throw new AppError(
        'PROBE_FAILED',
        res.stderrTail.slice(-5).join('\n') || `코드 ${String(res.exitCode)}`,
      );
    }

    let raw: RawProbe;
    try {
      raw = JSON.parse(res.stdout) as RawProbe;
    } catch (err) {
      throw new AppError('PROBE_FAILED', 'ffprobe JSON 파싱 실패', { cause: err });
    }
    if (!raw.streams || raw.streams.length === 0) {
      throw new AppError('PROBE_FAILED', '스트림이 없습니다');
    }
    return parseProbeJson(raw, {
      path: filePath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
}
