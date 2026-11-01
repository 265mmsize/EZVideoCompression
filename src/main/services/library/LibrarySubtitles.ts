/**
 * 영상과 같은 폴더의 같은 이름 자막 파일을 읽어 화면 표시용 텍스트로 돌려준다 (킹플레이어 자막 자동 로드에 대응).
 * 파일은 읽기만 한다. 형식은 확장자로 고르고, 문자 인코딩은 UTF-8·UTF-16·CP949 를 판정한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SubtitleFormat } from '../../../shared/types/domain';
import { decodeSubtitle, matchSubtitleCandidates, sniffEncoding } from '../ExternalSubtitleService';

/** 화면에 띄우는 형식. SMI 등 나머지는 지원하지 않는다. */
export const DISPLAY_SUBTITLE_MAX_BYTES = 2 * 1024 * 1024;

export interface LoadedSubtitle {
  fileName: string;
  format: SubtitleFormat | 'ssa';
  language: string | null;
  text: string;
}

export function formatOfExtension(fileName: string): SubtitleFormat | 'ssa' | null {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.srt') return 'srt';
  if (ext === '.vtt') return 'webvtt';
  if (ext === '.ass') return 'ass';
  if (ext === '.ssa') return 'ssa';
  return null;
}

export function loadSubtitlesFor(videoPath: string): LoadedSubtitle[] {
  const dir = path.dirname(videoPath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: LoadedSubtitle[] = [];
  for (const c of matchSubtitleCandidates(path.basename(videoPath), names, dir)) {
    const format = formatOfExtension(c.fileName);
    if (format === null) continue;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(c.path);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0 || st.size > DISPLAY_SUBTITLE_MAX_BYTES) continue;
    const buf = fs.readFileSync(c.path);
    const enc = sniffEncoding(buf);
    if (enc === 'unknown') continue;
    out.push({
      fileName: c.fileName,
      format,
      language: c.tags.length > 0 ? (c.tags[0] ?? null) : null,
      text: decodeSubtitle(buf, enc),
    });
  }
  return out;
}
