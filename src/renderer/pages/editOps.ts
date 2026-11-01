/**
 * 영상 편집기의 순수 계산 (화면과 메인 렌더 계획이 같은 규칙을 쓴다).
 */
import type { EditClip } from '../../shared/types/domain';

export const MIN_PIECE_SEC = 0.2;
export const MAX_EQUAL_PARTS = 10;

/** 클립의 결과 길이 (속도 적용 후) */
export function clipDur(c: EditClip): number {
  return Math.max(0, c.outSec - c.inSec) / c.speed;
}

/** 다음 클립과 겹치는 전환 길이 (양쪽 길이의 절반 이하) */
export function transitionSec(prev: EditClip, next: EditClip | undefined): number {
  if (!next || prev.transition.type === 'none') return 0;
  return Math.max(
    0,
    Math.min(prev.transition.durationSec, Math.min(clipDur(prev), clipDur(next)) * 0.5),
  );
}

/** 각 클립의 타임라인 시작 시각과 전체 길이 */
export function layout(clips: EditClip[]): { starts: number[]; total: number } {
  const starts: number[] = [];
  let t = 0;
  clips.forEach((c, i) => {
    starts.push(t);
    t += clipDur(c) - transitionSec(c, clips[i + 1]);
  });
  return { starts, total: Math.max(0, t) };
}

/**
 * 클립을 같은 길이 n 조각으로 나눈다. 첫 조각은 원래 id 와 텍스트를 받고,
 * 마지막 조각은 원래 전환을 이어받는다. 너무 짧아 나눌 수 없으면 원래 클립 하나를 돌려준다.
 */
export function splitEqually(c: EditClip, n: number, newId: () => string): EditClip[] {
  const parts = Math.floor(n);
  if (!Number.isFinite(parts) || parts < 2 || parts > MAX_EQUAL_PARTS) return [c];
  const span = c.outSec - c.inSec;
  if (span / parts < MIN_PIECE_SEC) return [c];
  const out: EditClip[] = [];
  for (let i = 0; i < parts; i++) {
    const inSec = c.inSec + (span * i) / parts;
    const outSec = c.inSec + (span * (i + 1)) / parts;
    const last = i === parts - 1;
    out.push({
      ...c,
      id: i === 0 ? c.id : newId(),
      inSec: round3(inSec),
      outSec: round3(outSec),
      texts: i === 0 ? c.texts : [],
      transition: last ? c.transition : { type: 'none', durationSec: c.transition.durationSec },
    });
  }
  return out;
}

/** 유튜브 설명란에 붙여 넣을 챕터 목록. 시작은 0:00 이어야 한다. */
export function chapterLines(clips: EditClip[]): string[] {
  const { starts } = layout(clips);
  return clips.map((c, i) => `${formatChapterTime(starts[i] ?? 0)} ${baseName(c.fileName)}`);
}

/** 0:00, 1:05, 1:02:03 형식 */
export function formatChapterTime(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${String(h)}:${String(m).padStart(2, '0')}:${ss}`;
  return `${String(m)}:${ss}`;
}

function baseName(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i > 0 ? fileName.slice(0, i) : fileName;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
