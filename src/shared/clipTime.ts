/**
 * 영상 편집 클립의 시간 규칙 (순수 함수). 렌더 계획, 미리보기, 편집 화면이 같은 규칙을 쓴다.
 * - 보통 클립: 원본 구간 ÷ 배속
 * - 프레임 고정(still) 클립: 원본의 한 프레임을 stillSec 동안 멈춰 보여 준다 (소리 없음)
 */
import type { EditClip } from './types/domain';

/** 프레임 고정 기본 길이 (초) */
export const FREEZE_DEFAULT_SEC = 3;
/** 프레임 고정 클립이 원본에서 읽는 짧은 구간 (한 프레임 안팎) */
export const FREEZE_FRAME_SEC = 1 / 30;
/** 페이드 최대 길이: 클립 길이의 절반 */
export const FADE_MAX_RATIO = 0.5;

export function clipDuration(
  c: Pick<EditClip, 'inSec' | 'outSec' | 'speed' | 'still' | 'stillSec'>,
): number {
  if (c.still) return Math.max(0, c.stillSec ?? FREEZE_DEFAULT_SEC);
  return Math.max(0, c.outSec - c.inSec) / c.speed;
}

/** 화면에 보이는 이름 (사용자가 바꾼 이름이 있으면 그것) */
export function clipLabel(c: Pick<EditClip, 'label' | 'fileName'>): string {
  const t = c.label?.trim();
  return t ? t : c.fileName;
}

/**
 * 클립 안 시각 localSec 의 페이드 배율 (0~1). 인 구간은 0→1, 아웃 구간은 1→0.
 * durSec 은 클립 결과 길이 (배속 적용 후).
 */
export function fadeFactor(
  c: Pick<EditClip, 'fadeInSec' | 'fadeOutSec'>,
  localSec: number,
  durSec: number,
): number {
  let g = 1;
  const fi = c.fadeInSec ?? 0;
  const fo = c.fadeOutSec ?? 0;
  if (fi > 0 && localSec < fi) g = Math.min(g, Math.max(0, localSec) / fi);
  if (fo > 0 && localSec > durSec - fo) g = Math.min(g, Math.max(0, durSec - localSec) / fo);
  return Math.min(1, Math.max(0, g));
}

/** 이 클립에 넣을 수 있는 최대 페이드 길이 */
export function maxFadeSec(durSec: number): number {
  return Math.max(0, durSec * FADE_MAX_RATIO);
}
