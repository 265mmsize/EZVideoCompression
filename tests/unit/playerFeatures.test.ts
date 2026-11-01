/**
 * 킹플레이어·킹뷰 기능의 순수 로직: 자막 파싱, 책갈피, 색상 변환, 화면 좌표, 구간 검증, 필름 목록 인자
 */
import { describe, expect, it } from 'vitest';
import { addBookmark, nextBookmark, parseBookmarks } from '../../src/renderer/library/playerMath';
import { cueAt, parseSubtitles } from '../../src/renderer/library/subtitleParse';
import { colorPickerText } from '../../src/renderer/library/colorText';
import {
  rgbToHex,
  rgbToHsl,
  rgbToHsv,
  screenToImagePixel,
} from '../../src/renderer/library/colorMath';
import {
  buildConcatListText,
  buildFrameArgs,
  firstKeyframeAtOrAfter,
  parseKeyframeTimes,
  validateRanges,
} from '../../src/main/services/library/ClipCutService';

describe('자막 파싱', () => {
  it('SRT: 번호, 시각(쉼표), 여러 줄, HTML 태그 제거', () => {
    const srt =
      '1\n00:00:01,000 --> 00:00:03,500\n<i>안녕</i>\n하세요\n\n2\n00:00:04,000 --> 00:00:05,000\nHello\n';
    const cues = parseSubtitles(srt, 'srt');
    expect(cues).toEqual([
      { startSec: 1, endSec: 3.5, text: '안녕\n하세요' },
      { startSec: 4, endSec: 5, text: 'Hello' },
    ]);
  });

  it('WebVTT: 헤더와 큐 설정(align 등)을 무시하고 점 구분 시각을 읽는다', () => {
    const vtt =
      'WEBVTT\n\n00:01.000 --> 00:02.000 align:center\n첫 줄\n\n01:00:00.500 --> 01:00:01.000\n둘째\n';
    const cues = parseSubtitles(vtt, 'webvtt');
    expect(cues.map((c) => [c.startSec, c.endSec, c.text])).toEqual([
      [1, 2, '첫 줄'],
      [3600.5, 3601, '둘째'],
    ]);
  });

  it('ASS: Format 열 순서를 따르고, 텍스트의 쉼표와 덮어쓰기 태그를 처리한다', () => {
    const ass = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\an8}안녕, 세상\\N둘째 줄',
    ].join('\n');
    expect(parseSubtitles(ass, 'ass')).toEqual([
      { startSec: 1, endSec: 2.5, text: '안녕, 세상\n둘째 줄' },
    ]);
  });

  it('시각 t 의 자막을 찾는다 (끝 시각은 포함하지 않음)', () => {
    const cues = parseSubtitles(
      '1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n',
      'srt',
    );
    expect(cueAt(cues, 1.5)?.text).toBe('A');
    expect(cueAt(cues, 2)).toBeNull();
    expect(cueAt(cues, 3.2)?.text).toBe('B');
    expect(cueAt(cues, 0.5)).toBeNull();
  });
});

describe('책갈피', () => {
  it('같은 자리 근처는 하나로 묶고, 이전·다음을 찾는다', () => {
    let list = addBookmark([], 10);
    list = addBookmark(list, 10.2);
    list = addBookmark(list, 30);
    list = addBookmark(list, 5);
    expect(list).toEqual([5, 10, 30]);
    expect(nextBookmark(list, 10, 1)).toBe(30);
    expect(nextBookmark(list, 10, -1)).toBe(5);
    expect(nextBookmark(list, 30, 1)).toBeNull();
    expect(nextBookmark(list, 5, -1)).toBeNull();
  });

  it('저장된 JSON 은 숫자만 읽고 잘못된 값은 버린다', () => {
    expect(parseBookmarks('[30, "x", 5, -1]')).toEqual([5, 30]);
    expect(parseBookmarks('{"a":1}')).toEqual([]);
    expect(parseBookmarks('not json')).toEqual([]);
    expect(parseBookmarks(null)).toEqual([]);
  });
});

describe('색상과 화면 좌표', () => {
  it('HEX, HSL, HSV 를 알려진 색으로 확인한다', () => {
    expect(rgbToHex({ r: 255, g: 128, b: 0 })).toBe('#ff8000');
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, l: 50 });
    expect(rgbToHsv({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 100, v: 100 });
    expect(rgbToHsl({ r: 128, g: 128, b: 128 })).toEqual({ h: 0, s: 0, l: 50 });
    expect(colorPickerText({ r: 255, g: 0, b: 0 })).toContain('HEX  #ff0000');
  });

  it('요소 좌표를 원본 픽셀로 바꾸고, 여백과 확대 상태를 고려한다', () => {
    const fit = { scale: 1, tx: 0, ty: 0 };
    // 요소 200×100, 원본 400×200 → 맞춤 비율 0.5, 여백 없음
    expect(screenToImagePixel(fit, 200, 100, 400, 200, 100, 50)).toEqual({ x: 200, y: 100 });
    // 원본 100×100 을 200×100 요소에 맞추면 가로 여백 50px 씩
    expect(screenToImagePixel(fit, 200, 100, 100, 100, 10, 50)).toBeNull();
    expect(screenToImagePixel(fit, 200, 100, 100, 100, 100, 50)).toEqual({ x: 50, y: 50 });
    // 2배 확대, 이동 없음: 화면 (100,50) 은 맞춤 기준 (50,25) → 원본 (25,12)
    expect(screenToImagePixel({ scale: 2, tx: 0, ty: 0 }, 200, 100, 200, 100, 100, 50)).toEqual({
      x: 50,
      y: 25,
    });
  });
});

describe('구간과 키프레임', () => {
  it('구간 검증: 개수, 최소 길이, 영상 길이 초과', () => {
    expect(validateRanges([], 10)).not.toBeNull();
    expect(validateRanges([{ startSec: 1, endSec: 1.2 }], 10)).toContain('짧');
    expect(validateRanges([{ startSec: 1, endSec: 11 }], 10)).toContain('넘');
    expect(validateRanges([{ startSec: 1, endSec: 5 }], 10)).toBeNull();
    expect(
      validateRanges(
        Array.from({ length: 21 }, () => ({ startSec: 0, endSec: 2 })),
        100,
      ),
    ).toContain('최대');
  });

  it('키프레임 목록을 읽고 시작 이후 첫 키프레임을 찾는다', () => {
    const times = parseKeyframeTimes(
      '0.000000,K__\n1.000000,___\n2.000000,K__\n\n4.000000,K__\nx,K__\n',
    );
    expect(times).toEqual([0, 2, 4]);
    expect(firstKeyframeAtOrAfter(times, 1.5)).toBe(2);
    expect(firstKeyframeAtOrAfter(times, 4)).toBe(4);
    expect(firstKeyframeAtOrAfter(times, 4.5)).toBeNull();
  });

  it('합치기 목록은 작은따옴표를 이스케이프하고, 프레임 추출 인자는 시각을 고정 소수로 쓴다', () => {
    expect(buildConcatListText(['/a/b.mp4', "/c/it's.mp4"])).toBe(
      "file '/a/b.mp4'\nfile '/c/it'\\''s.mp4'\n",
    );
    const args = buildFrameArgs('/v/a.mp4', '/v/out.png', 12.5);
    expect(args).toEqual(expect.arrayContaining(['-ss', '12.500', '-frames:v', '1']));
    expect(args[args.length - 1]).toBe('/v/out.png');
  });
});
