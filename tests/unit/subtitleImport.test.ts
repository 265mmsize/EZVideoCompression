/** 자막 가져오기: 원본 시각을 클립 안 시각으로 바꾸고, 범위 밖과 빈 글자는 뺀다 */
import { describe, expect, it } from 'vitest';
import { cuesToTexts, MAX_CLIP_TEXTS } from '../../src/renderer/pages/subtitleImport';

let n = 0;
const newId = (): string => `s${String(++n)}`;

describe('자막을 클립 글자 표시로', () => {
  it('원본 시각에서 클립 안 시각으로 환산한다 (inSec, 배속)', () => {
    const texts = cuesToTexts(
      [{ startSec: 4, endSec: 6, text: ' 안녕 ' }],
      { inSec: 2, speed: 2, durationSec: 10 },
      newId,
    );
    // 원본 4~6초 → 클립 안 (4-2)/2=1 ~ (6-2)/2=2
    expect(texts[0]).toMatchObject({
      text: '안녕',
      startSec: 1,
      endSec: 2,
      x: 'center',
      y: 'bottom',
      boxed: true,
    });
  });

  it('클립 밖 자막과 빈 글자는 뺀다, 걸친 자막은 클립 끝에 맞춘다', () => {
    const texts = cuesToTexts(
      [
        { startSec: 0, endSec: 1, text: '앞' },
        { startSec: 0.5, endSec: 3, text: '걸침' },
        { startSec: 20, endSec: 21, text: '뒤' },
        { startSec: 5, endSec: 6, text: '   ' },
      ],
      { inSec: 1, speed: 1, durationSec: 5 },
      newId,
    );
    expect(texts.map((t) => t.text)).toEqual(['걸침']);
    expect(texts[0]).toMatchObject({ startSec: 0, endSec: 2 });
    expect(
      cuesToTexts(
        [{ startSec: 0, endSec: 1, text: '앞' }],
        { inSec: 1, speed: 1, durationSec: 5 },
        newId,
      ),
    ).toEqual([]);
  });

  it('한 클립에는 최대 개수까지만 넣는다', () => {
    const cues = Array.from({ length: MAX_CLIP_TEXTS + 20 }, (_, i) => ({
      startSec: i,
      endSec: i + 0.5,
      text: `자막 ${String(i)}`,
    }));
    expect(cuesToTexts(cues, { inSec: 0, speed: 1, durationSec: 10000 }, newId)).toHaveLength(
      MAX_CLIP_TEXTS,
    );
  });
});
