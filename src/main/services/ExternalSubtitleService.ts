/**
 * 외부 자막 파일 감지와 준비.
 *
 * 규칙
 * - 영상과 같은 폴더에서 `영상이름.srt`, `영상이름.ko.srt`, `영상이름.ko.forced.ass` 형태만 찾는다.
 *   (영상 기본 이름 + 점 + 선택적 태그 + 자막 확장자). 다른 폴더나 다른 이름은 찾지 않는다.
 * - 형식은 확장자가 아니라 ffprobe 가 읽은 결과로 확정한다. 읽지 못하면 사유와 함께 제외한다.
 * - 문자 인코딩은 UTF-8(BOM 유무), UTF-16(BOM), CP949 순서로 판정한다.
 *   변환은 작업 임시 폴더의 복사본에만 하고 원본 자막 파일은 어떤 경우에도 수정하지 않는다.
 * - 분석 시점의 크기·수정 시간을 기록해 두고, 인코딩 직전에 다시 비교한다. 바뀌었으면 INPUT_CHANGED 로 중단한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  DetectedSubtitle,
  ExternalSubtitleDecision,
  SubtitleEncoding,
  SubtitleFormat,
} from '../../shared/types/domain';
import { AppError } from './AppError';
import type { FFmpegProcessService } from './FFmpegProcessService';

export const SUBTITLE_EXTENSIONS = ['.srt', '.ass', '.ssa', '.vtt'] as const;
/** 영상 하나에 붙일 외부 자막 파일 상한 */
export const MAX_EXTERNAL_SUBTITLES = 10;
/** 이보다 큰 파일은 자막으로 보지 않는다 */
export const MAX_SUBTITLE_BYTES = 20 * 1024 * 1024;
/** 파일명 태그 하나의 최대 길이 (영상.ko.forced.srt 의 ko, forced) */
const MAX_TAG_LENGTH = 16;

/** ffprobe format_name → 앱 형식 이름 */
const FORMAT_BY_PROBE: Readonly<Record<string, SubtitleFormat>> = {
  srt: 'srt',
  ass: 'ass',
  webvtt: 'webvtt',
};

/** 파일명 태그(2글자)에서 ISO 639-2 코드로. 3글자 알파벳 태그는 그대로 쓴다. */
const LANGUAGE_BY_TAG: Readonly<Record<string, string>> = {
  ko: 'kor',
  en: 'eng',
  ja: 'jpn',
  zh: 'zho',
  fr: 'fra',
  de: 'deu',
  es: 'spa',
  it: 'ita',
  pt: 'por',
  ru: 'rus',
  vi: 'vie',
  th: 'tha',
  id: 'ind',
  ar: 'ara',
  tr: 'tur',
  nl: 'nld',
  pl: 'pol',
  sv: 'swe',
};

export interface SubtitleCandidate {
  path: string;
  fileName: string;
  /** 영상 기본 이름과 확장자 사이의 태그들 (없으면 빈 배열) */
  tags: string[];
}

/**
 * 폴더 안의 파일 이름 목록에서 영상에 붙는 자막 후보를 고른다. 순수 함수 (파일시스템 접근 없음).
 * 태그 없는 파일을 먼저, 그 다음은 이름순으로 정렬한다.
 */
export function matchSubtitleCandidates(
  videoFileName: string,
  siblingNames: readonly string[],
  dir: string,
): SubtitleCandidate[] {
  const base = path.parse(videoFileName).name;
  if (!base) return [];
  const baseLower = base.toLowerCase();
  const out: SubtitleCandidate[] = [];
  for (const name of siblingNames) {
    const lower = name.toLowerCase();
    const ext = SUBTITLE_EXTENSIONS.find((e) => lower.endsWith(e));
    if (!ext) continue;
    const stem = name.slice(0, name.length - ext.length);
    const stemLower = stem.toLowerCase();
    let tags: string[];
    if (stemLower === baseLower) {
      tags = [];
    } else if (stemLower.startsWith(baseLower + '.')) {
      // 'ko' | 'ko.forced' — 각 태그는 비어 있지 않고 짧아야 한다
      tags = stem.slice(base.length + 1).split('.');
      if (tags.some((t) => t.length === 0 || t.length > MAX_TAG_LENGTH)) continue;
    } else {
      continue;
    }
    out.push({ path: path.join(dir, name), fileName: name, tags });
  }
  out.sort((a, b) => a.tags.length - b.tags.length || a.fileName.localeCompare(b.fileName));
  return out.slice(0, MAX_EXTERNAL_SUBTITLES);
}

/** 태그에서 언어 코드를 찾는다. 첫 번째로 언어처럼 보이는 태그만 쓴다. */
export function languageFromTags(tags: readonly string[]): string | null {
  for (const raw of tags) {
    const t = raw.toLowerCase();
    if (t.length === 2 && Object.hasOwn(LANGUAGE_BY_TAG, t)) return LANGUAGE_BY_TAG[t] ?? null;
    if (t.length === 3 && /^[a-z]{3}$/.test(t)) return t;
  }
  return null;
}

/** BOM 과 디코딩 시도로 인코딩을 판정한다. */
export function sniffEncoding(buf: Uint8Array): SubtitleEncoding {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  // BOM 없는 UTF-16: 널 바이트가 많으면 (라틴 문자가 2바이트 중 1바이트를 0 으로 채움) 홀짝 위치로 방향을 정한다.
  const nul = countNul(buf);
  if (buf.length >= 4 && nul.total * 10 >= buf.length) {
    return nul.odd >= nul.even ? 'utf-16le' : 'utf-16be';
  }
  if (tryDecode(buf, 'utf-8')) return 'utf-8';
  // WHATWG 의 euc-kr 라벨은 실제로는 windows-949(CP949) 디코더다.
  if (tryDecode(buf, 'euc-kr')) return 'cp949';
  return 'unknown';
}

function countNul(buf: Uint8Array): { total: number; odd: number; even: number } {
  let odd = 0;
  let even = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) continue;
    if (i % 2 === 1) odd++;
    else even++;
  }
  return { total: odd + even, odd, even };
}

function tryDecode(buf: Uint8Array, label: string): boolean {
  try {
    new TextDecoder(label, { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** 판정한 인코딩으로 읽어 BOM 없는 UTF-8 문자열로 만든다. */
export function decodeSubtitle(buf: Uint8Array, encoding: SubtitleEncoding): string {
  if (encoding === 'unknown') throw new Error('문자 인코딩을 판별할 수 없습니다');
  const label = encoding === 'cp949' ? 'euc-kr' : encoding;
  // ignoreBOM: false (기본) 이면 BOM 을 떼고 디코딩한다
  return new TextDecoder(label).decode(buf);
}

/**
 * 외부 자막 처리 결정 (순수 함수).
 * MKV: SRT·ASS 는 복사, WebVTT 는 SRT 로 변환. MP4: 모두 mov_text 로 변환 (ASS 스타일은 사라진다).
 */
export function decideExternalSubtitles(
  detected: readonly DetectedSubtitle[],
  settings: { container: 'mp4' | 'mkv'; externalSubtitles: boolean },
): ExternalSubtitleDecision[] {
  return detected.map((d) => {
    if (!settings.externalSubtitles) {
      return { ...d, action: 'exclude', reason: '설정에서 외부 자막 포함을 껐습니다.' };
    }
    if (d.format === null) {
      return {
        ...d,
        action: 'exclude',
        reason: `읽을 수 없어 제외합니다: ${d.error ?? '원인 불명'}`,
      };
    }
    if (d.encoding === 'unknown') {
      return {
        ...d,
        action: 'exclude',
        reason: '문자 인코딩(UTF-8, UTF-16, CP949)을 판별할 수 없어 제외합니다.',
      };
    }
    const enc = d.encoding === 'utf-8' ? '' : ` ${d.encoding.toUpperCase()} → UTF-8 변환 후`;
    if (settings.container === 'mp4') {
      const style = d.format === 'ass' ? ' ASS 스타일(글꼴·위치)은 유지되지 않습니다.' : '';
      return {
        ...d,
        action: 'transcode',
        reason: `MP4 에는${enc} mov_text 로 변환해 포함합니다.${style}`,
      };
    }
    if (d.format === 'webvtt') {
      return { ...d, action: 'transcode', reason: `MKV 에는${enc} SRT 로 변환해 포함합니다.` };
    }
    return { ...d, action: 'copy', reason: `MKV 에${enc} 그대로 포함합니다.` };
  });
}

/** 인코딩 직전 준비된 자막 입력 (작업 임시 폴더 안의 UTF-8 복사본) */
export interface PreparedSubtitle {
  /** FFmpeg 에 넘길 임시 복사본 경로 */
  inputPath: string;
  decision: ExternalSubtitleDecision;
}

export class ExternalSubtitleService {
  constructor(
    private readonly proc: FFmpegProcessService,
    private readonly getFfprobePath: () => string,
  ) {}

  /** 영상과 같은 폴더에서 자막 파일을 찾아 형식·인코딩·언어를 확인한다. 파일은 읽기만 한다. */
  async detect(videoPath: string, jobId?: string): Promise<DetectedSubtitle[]> {
    const dir = path.dirname(videoPath);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: DetectedSubtitle[] = [];
    for (const c of matchSubtitleCandidates(path.basename(videoPath), names, dir)) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(c.path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue; // 심볼릭 링크·디렉터리는 제외
      const base = {
        path: c.path,
        fileName: c.fileName,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        language: languageFromTags(c.tags),
      };
      if (st.size === 0 || st.size > MAX_SUBTITLE_BYTES) {
        out.push({
          ...base,
          format: null,
          encoding: 'unknown',
          error: st.size === 0 ? '빈 파일' : '20 MiB 를 넘는 파일',
        });
        continue;
      }
      const encoding = sniffEncoding(fs.readFileSync(c.path));
      const probed = await this.probeFormat(c.path, jobId);
      out.push({
        ...base,
        format: probed.format,
        encoding,
        error: probed.error,
      });
    }
    return out;
  }

  /**
   * 인코딩 직전: 분석 때와 같은 파일인지 확인하고 UTF-8 복사본을 임시 폴더에 만든다.
   * 제외된 결정은 건너뛴다. 원본 자막 파일은 수정하지 않는다.
   */
  prepare(decisions: readonly ExternalSubtitleDecision[], tempDir: string): PreparedSubtitle[] {
    const kept = decisions.filter((d) => d.action !== 'exclude');
    if (kept.length === 0) return [];
    const subDir = path.join(tempDir, 'subs');
    fs.mkdirSync(subDir, { recursive: true });
    return kept.map((d, i) => {
      let st: fs.Stats;
      try {
        st = fs.statSync(d.path);
      } catch (err) {
        throw new AppError('INPUT_CHANGED', `자막 파일을 찾을 수 없습니다: ${d.fileName}`, {
          cause: err,
        });
      }
      if (st.size !== d.sizeBytes || Math.abs(st.mtimeMs - d.mtimeMs) > 1) {
        throw new AppError('INPUT_CHANGED', `자막 파일이 분석 이후 바뀌었습니다: ${d.fileName}`);
      }
      const text = decodeSubtitle(fs.readFileSync(d.path), d.encoding);
      const ext = d.format === 'webvtt' ? '.vtt' : d.format === 'ass' ? '.ass' : '.srt';
      const inputPath = path.join(subDir, `${String(i)}${ext}`);
      fs.writeFileSync(inputPath, text, 'utf8');
      return { inputPath, decision: d };
    });
  }

  private async probeFormat(
    filePath: string,
    jobId?: string,
  ): Promise<{ format: SubtitleFormat | null; error: string | null }> {
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
        '-i',
        filePath,
      ],
      { timeoutMs: 30_000, captureStdout: true, jobId },
    );
    if (res.timedOut) return { format: null, error: 'ffprobe 시간 초과' };
    if (res.exitCode !== 0) {
      return { format: null, error: res.stderrTail.slice(-2).join(' ') || 'ffprobe 실패' };
    }
    try {
      const raw = JSON.parse(res.stdout) as {
        format?: { format_name?: string };
        streams?: { codec_type?: string }[];
      };
      const name = raw.format?.format_name ?? '';
      const format = FORMAT_BY_PROBE[name] ?? null;
      const hasSub = (raw.streams ?? []).some((s) => s.codec_type === 'subtitle');
      if (!format || !hasSub)
        return { format: null, error: `지원하지 않는 자막 형식: ${name || '?'}` };
      return { format, error: null };
    } catch {
      return { format: null, error: 'ffprobe 결과를 읽을 수 없습니다' };
    }
  }
}
