/**
 * 자막 파일을 클립의 글자 표시(텍스트)로 바꾼다 (순수 함수).
 * 자막 시각은 원본 영상의 시각으로 본다. 클립은 원본의 inSec 부터 배속으로 재생되므로
 * 클립 안 시각 = (원본 시각 - inSec) ÷ 배속 으로 환산한다.
 */
import type { EditTextOverlay } from '../../shared/types/domain';

/** 클립 하나에 넣을 수 있는 글자 표시의 최대 개수 */
export const MAX_CLIP_TEXTS = 500;

export interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

export function cuesToTexts(
  cues: readonly SubtitleCue[],
  clip: { inSec: number; speed: number; durationSec: number },
  newId: () => string,
): EditTextOverlay[] {
  const out: EditTextOverlay[] = [];
  for (const cue of cues) {
    const text = cue.text.trim();
    if (text === '') continue;
    const s = (cue.startSec - clip.inSec) / clip.speed;
    const e = (cue.endSec - clip.inSec) / clip.speed;
    if (e <= 0 || s >= clip.durationSec) continue;
    out.push({
      id: newId(),
      text,
      x: 'center',
      y: 'bottom',
      fontSize: 40,
      color: '#ffffff',
      boxed: true,
      startSec: Math.max(0, s),
      endSec: Math.min(clip.durationSec, e),
    });
    if (out.length >= MAX_CLIP_TEXTS) break;
  }
  return out;
}
