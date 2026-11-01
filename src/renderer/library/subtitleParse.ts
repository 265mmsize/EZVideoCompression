/**
 * 자막 텍스트를 시간 구간 목록으로 바꾼다 (SRT, WebVTT, ASS/SSA). 순수 함수, 화면 표시용.
 * 태그(<i>, {\an8} 등)는 제거하고 줄바꿈만 남긴다.
 */
export interface Cue {
  startSec: number;
  endSec: number;
  text: string;
}

/** 시각: 시(선택), 분, 초, 소수 (WebVTT 는 mm:ss.mmm 도 허용) */
const TIME = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;
const TIME_LINE = new RegExp(`${TIME.source}\\s*-->\\s*${TIME.source}`);

function toSec(h: string, m: string, s: string, frac: string): number {
  const ms = Number(frac.padEnd(3, '0').slice(0, 3));
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + ms / 1000;
}

/** 태그 제거와 줄바꿈 정리 */
export function cleanCueText(raw: string): string {
  return raw
    .replace(/\{\\[^}]*\}/g, '') // ASS 덮어쓰기 {\an8} 등
    .replace(/\\N/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

function parseBlocks(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => TIME_LINE.test(l));
    if (idx < 0) continue;
    const m = TIME_LINE.exec(lines[idx] ?? '');
    if (!m) continue;
    const start = toSec(m[1] ?? '0', m[2] ?? '0', m[3] ?? '0', m[4] ?? '0');
    const end = toSec(m[5] ?? '0', m[6] ?? '0', m[7] ?? '0', m[8] ?? '0');
    const body = cleanCueText(lines.slice(idx + 1).join('\n'));
    if (end > start && body.length > 0) cues.push({ startSec: start, endSec: end, text: body });
  }
  return cues;
}

function parseAss(text: string): Cue[] {
  const cues: Cue[] = [];
  let fields: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*Format:/i.test(line)) {
      fields = line
        .replace(/^\s*Format:\s*/i, '')
        .split(',')
        .map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^\s*Dialogue:/i.test(line)) continue;
    const values = line.replace(/^\s*Dialogue:\s*/i, '').split(',');
    const si = fields.indexOf('start');
    const ei = fields.indexOf('end');
    const ti = fields.indexOf('text');
    if (si < 0 || ei < 0 || ti < 0) continue;
    // 텍스트에는 쉼표가 들어갈 수 있으므로 마지막 필드는 나머지 전부다
    const textValue = values.slice(ti).join(',');
    const sm = /(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(values[si] ?? '');
    const em = /(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(values[ei] ?? '');
    if (!sm || !em) continue;
    const start = toSec(sm[1] ?? '0', sm[2] ?? '0', sm[3] ?? '0', sm[4] ?? '0');
    const end = toSec(em[1] ?? '0', em[2] ?? '0', em[3] ?? '0', em[4] ?? '0');
    const body = cleanCueText(textValue);
    if (end > start && body.length > 0) cues.push({ startSec: start, endSec: end, text: body });
  }
  return cues;
}

export function parseSubtitles(text: string, format: 'srt' | 'webvtt' | 'ass' | 'ssa'): Cue[] {
  const cues = format === 'ass' || format === 'ssa' ? parseAss(text) : parseBlocks(text);
  return cues.sort((a, b) => a.startSec - b.startSec);
}

/** 시각 t 에 보여야 할 자막 (겹치면 먼저 시작한 것). 없으면 null. */
export function cueAt(cues: readonly Cue[], t: number): Cue | null {
  for (const c of cues) {
    if (t >= c.startSec && t < c.endSec) return c;
    if (c.startSec > t) break;
  }
  return null;
}
