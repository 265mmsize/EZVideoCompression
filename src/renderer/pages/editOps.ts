/**
 * 영상 편집기의 순수 계산 (화면과 메인 렌더 계획이 같은 규칙을 쓴다).
 */
import { sliceMotion } from '../../shared/keyframes';
import { clipDuration } from '../../shared/clipTime';
import type { EditClip } from '../../shared/types/domain';

export const MIN_PIECE_SEC = 0.2;
export const MAX_EQUAL_PARTS = 10;
export const MAX_PIECES = 50;
const MAX_INTERVAL_PIECES = 50;

/** 클립의 결과 길이 (속도 적용 후) */
export function clipDur(c: EditClip): number {
  return clipDuration(c);
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
 * 클립을 주어진 지점(원본 기준 초, 시작과 끝 사이)에서 나눈다. 첫 조각은 원래 id 와 텍스트를 받고,
 * 마지막 조각은 원래 전환을 이어받는다. 조각이 너무 짧아지면 나누지 않고 원래 클립을 돌려준다.
 */
export function splitAt(c: EditClip, cuts: number[], newId: () => string): EditClip[] {
  // 프레임 고정 클립은 나눌 수 없다 (길이가 원본 구간이 아니다)
  if (c.still) return [c];
  const points = [...cuts].filter((t) => t > c.inSec && t < c.outSec).sort((a, b) => a - b);
  const bounds = [c.inSec, ...points, c.outSec];
  for (let i = 0; i + 1 < bounds.length; i++) {
    if ((bounds[i + 1] ?? 0) - (bounds[i] ?? 0) < MIN_PIECE_SEC) return [c];
  }
  if (points.length === 0 || points.length + 1 > MAX_PIECES) return [c];
  const out: EditClip[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const last = i === bounds.length - 2;
    out.push({
      ...c,
      id: i === 0 ? c.id : newId(),
      inSec: round3(bounds[i] ?? c.inSec),
      outSec: round3(bounds[i + 1] ?? c.outSec),
      texts: i === 0 ? c.texts : [],
      // 페이드는 바깥쪽 조각에만 남는다 (인은 첫 조각, 아웃은 마지막 조각)
      fadeInSec: i === 0 ? c.fadeInSec : 0,
      fadeOutSec: last ? c.fadeOutSec : 0,
      transition: last ? c.transition : { type: 'none', durationSec: c.transition.durationSec },
      motion: sliceMotion(
        c.motion,
        ((bounds[i] ?? c.inSec) - c.inSec) / c.speed,
        ((bounds[i + 1] ?? c.outSec) - c.inSec) / c.speed,
      ),
    });
  }
  return out;
}

/** 같은 길이 n 조각으로 나눈다. n 은 2~10. */
export function splitEqually(c: EditClip, n: number, newId: () => string): EditClip[] {
  const parts = Math.floor(n);
  if (!Number.isFinite(parts) || parts < 2 || parts > MAX_EQUAL_PARTS) return [c];
  const span = c.outSec - c.inSec;
  const cuts = Array.from({ length: parts - 1 }, (_, i) => c.inSec + (span * (i + 1)) / parts);
  return splitAt(c, cuts, newId);
}

/**
 * 일정한 간격(초)으로 나눈다. 마지막 조각이 너무 짧으면 앞 조각과 합친다. 조각은 최대 50개까지다.
 */
export function splitByInterval(c: EditClip, seconds: number, newId: () => string): EditClip[] {
  if (!Number.isFinite(seconds) || seconds < MIN_PIECE_SEC) return [c];
  const span = c.outSec - c.inSec;
  const count = Math.ceil(span / seconds);
  if (count < 2 || count > MAX_INTERVAL_PIECES) return [c];
  const cuts = Array.from({ length: count - 1 }, (_, i) => c.inSec + seconds * (i + 1));
  // 마지막 조각이 짧으면 마지막 자르기 지점을 없애 앞 조각에 붙인다
  const last = cuts[cuts.length - 1];
  if (last !== undefined && c.outSec - last < MIN_PIECE_SEC) cuts.pop();
  return splitAt(c, cuts, newId);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
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
