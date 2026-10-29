/**
 * 라이브러리 상세(미리보기) 패널 너비. 프리셋 스위치와 드래그 핸들이 함께 쓴다.
 * 값은 브라우저 저장소에 기억한다 (사용자별 편의 설정, 실패해도 기본값으로 동작).
 */
export type DetailWidth = number | 'max';
export const DETAIL_PRESETS = { s: 360, m: 440, l: 680 } as const;
const DETAIL_WIDTH_KEY = 'vslim.library.detailWidth';
const DETAIL_MIN = 300;
const DETAIL_MAX = 1600;

export function clampDetailWidth(w: number): number {
  return Math.min(DETAIL_MAX, Math.max(DETAIL_MIN, Math.round(w)));
}

export function readDetailWidth(): DetailWidth {
  try {
    const raw = localStorage.getItem(DETAIL_WIDTH_KEY);
    if (raw === 'max') return 'max';
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return clampDetailWidth(n);
  } catch {
    // 저장소 접근 실패는 기본값으로
  }
  return DETAIL_PRESETS.m;
}

export function saveDetailWidth(w: DetailWidth): void {
  try {
    localStorage.setItem(DETAIL_WIDTH_KEY, String(w));
  } catch {
    // 저장소를 못 써도 동작에는 지장이 없다
  }
}
