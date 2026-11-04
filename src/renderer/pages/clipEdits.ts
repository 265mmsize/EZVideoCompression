/**
 * 클립 편집 계산 (순수 함수): 프레임 고정, 복사용 새 id, 재생 헤드 기준 프레임 고정 위치 판정.
 */
import { FREEZE_DEFAULT_SEC, FREEZE_FRAME_SEC, clipLabel } from '../../shared/clipTime';
import type { EditClip } from '../../shared/types/domain';

/** 가장 짧은 보통 조각 (원본 기준 초) */
const MIN_SOURCE_PIECE = 0.1;

/**
 * 원본 시각 cutSource 에서 클립을 세 조각으로 나눈다: 앞(보통) · 고정 프레임 · 뒤(보통).
 * 앞 조각은 원래 id, 고정 프레임과 뒤 조각은 새 id 를 받는다. 나눌 수 없으면 null.
 */
export function freezeAt(
  c: EditClip,
  cutSource: number,
  newId: () => string,
  stillSec: number = FREEZE_DEFAULT_SEC,
): EditClip[] | null {
  if (c.still) return null;
  if (cutSource - c.inSec < MIN_SOURCE_PIECE) return null;
  if (c.outSec - cutSource < MIN_SOURCE_PIECE + FREEZE_FRAME_SEC) return null;
  const head: EditClip = {
    ...c,
    outSec: cutSource,
    fadeOutSec: 0,
    transition: { type: 'none', durationSec: 1 },
  };
  const still: EditClip = {
    ...c,
    id: newId(),
    label: `${clipLabel(c)} (고정)`,
    still: true,
    stillSec: stillSec > 0 ? stillSec : FREEZE_DEFAULT_SEC,
    inSec: cutSource,
    outSec: cutSource + FREEZE_FRAME_SEC,
    speed: 1,
    mute: true,
    volume: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    stabilize: false,
    texts: [],
    transition: { type: 'none', durationSec: 1 },
    motion: undefined,
  };
  const tail: EditClip = {
    ...c,
    id: newId(),
    inSec: cutSource,
    texts: [],
    fadeInSec: 0,
  };
  return [head, still, tail];
}

/** 붙여넣기용 복사본: 새 id, 같은 설정. 전환은 붙여넣은 뒤 끝 클립이 되므로 없앤다. */
export function copyOf(c: EditClip, newId: () => string): EditClip {
  return { ...c, id: newId(), transition: { type: 'none', durationSec: 1 } };
}
