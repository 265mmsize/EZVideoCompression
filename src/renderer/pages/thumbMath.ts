/** 클립 썸네일의 순수 계산: 개수와 읽을 원본 시각 (화면 파일과 분리해 테스트한다) */
import type { EditClip } from '../../shared/types/domain';

const MAX_THUMBS = 12;
const THUMB_PX = 72;

/** 폭에 맞춘 썸네일 개수 (1~12) */
export function thumbCount(widthPx: number): number {
  return Math.max(1, Math.min(MAX_THUMBS, Math.floor(widthPx / THUMB_PX)));
}

/** 썸네일을 뽑을 원본 시각: 고정 클립은 한 프레임, 보통 클립은 구간을 고르게 나눈 가운데 */
export function thumbTimes(
  c: Pick<EditClip, 'inSec' | 'outSec' | 'still'>,
  count: number,
): number[] {
  if (c.still) return [c.inSec];
  const span = Math.max(0, c.outSec - c.inSec);
  return Array.from({ length: count }, (_, i) => c.inSec + (span * (i + 0.5)) / count);
}
