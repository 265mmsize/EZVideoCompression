/** 영상 편집 실시간 미리보기 계산: 겹침과 전환, 배치, 필터, 텍스트·워터마크, 음악, 캔버스 규칙 공유 */
import { describe, expect, it } from 'vitest';
import type { EditClip, EditMusic, EditTextOverlay } from '../../src/shared/types/domain';
import { resolveCanvas as mainResolveCanvas } from '../../src/main/services/edit/EditGraphBuilder';
import { resolveCanvas } from '../../src/shared/editCanvas';
import {
  clipGain,
  contentBox,
  cssFilter,
  layersAt,
  musicGain,
  musicTimeAt,
  needsSeek,
  preloadIndex,
  textStyle,
  textVisible,
  watermarkStyle,
} from '../../src/renderer/pages/previewMath';

function clip(id: string, inSec: number, outSec: number, extra: Partial<EditClip> = {}): EditClip {
  return {
    id,
    path: `/v/${id}.mp4`,
    fileName: `${id}.mp4`,
    sourceDurationSec: 100,
    sourceWidth: 1920,
    sourceHeight: 1080,
    hasAudio: true,
    inSec,
    outSec,
    speed: 1,
    volume: 1,
    mute: false,
    stabilize: false,
    rotate: 0,
    flipH: false,
    flipV: false,
    filters: { brightness: 0, contrast: 1, saturation: 1, sharpen: 0, denoise: 0 },
    transition: { type: 'none', durationSec: 1 },
    texts: [],
    ...extra,
  };
}

const music: EditMusic = {
  path: '/m/song.mp3',
  fileName: 'song.mp3',
  sourceDurationSec: 10,
  volume: 0.8,
  fadeInSec: 2,
  fadeOutSec: 2,
  loop: true,
  originalMix: 0.5,
};

describe('보이는 클립과 전환', () => {
  it('전환이 없으면 한 클립만 보이고 원본 시간을 환산한다', () => {
    const clips = [clip('a', 10, 14), clip('b', 0, 4, { speed: 2 })];
    expect(layersAt(clips, 1)).toEqual([{ index: 0, localSec: 1, sourceSec: 11, opacity: 1 }]);
    // b 는 4초부터, 배속 2 → 결과 길이 2초. 5초는 b 의 1초, 원본 2초
    expect(layersAt(clips, 5)).toEqual([{ index: 1, localSec: 1, sourceSec: 2, opacity: 1 }]);
  });

  it('교차 전환 구간에서는 두 클립이 겹치고 들어오는 클립이 점점 진해진다', () => {
    const clips = [
      clip('a', 0, 4, { transition: { type: 'fade', durationSec: 1 } }),
      clip('b', 0, 4),
    ];
    // b 시작 = 4 - 1 = 3초. 3.5초는 전환 절반
    const l = layersAt(clips, 3.5);
    expect(l.map((x) => x.index)).toEqual([0, 1]);
    expect(l[0]?.opacity).toBe(1);
    expect(l[1]?.opacity).toBeCloseTo(0.5, 6);
  });

  it('검정 페이드는 앞 절반에 나가는 클립이 어두워지고 뒤 절반에 들어오는 클립이 밝아진다', () => {
    const clips = [
      clip('a', 0, 4, { transition: { type: 'fadeblack', durationSec: 1 } }),
      clip('b', 0, 4),
    ];
    const early = layersAt(clips, 3.25);
    expect(early[0]?.opacity).toBeCloseTo(0.5, 6);
    expect(early[1]?.opacity).toBe(0);
    const late = layersAt(clips, 3.75);
    expect(late[0]?.opacity).toBe(0);
    expect(late[1]?.opacity).toBeCloseTo(0.5, 6);
  });

  it('끝이나 음수 시각, 빈 프로젝트는 빈 배열', () => {
    const clips = [clip('a', 0, 2)];
    expect(layersAt(clips, 2)).toEqual([]);
    expect(layersAt(clips, -1)).toEqual([]);
    expect(layersAt([], 0)).toEqual([]);
  });

  it('클립 끝이 가까우면 다음 클립을 미리 불러 둔다', () => {
    const clips = [clip('a', 0, 4), clip('b', 0, 4)];
    expect(preloadIndex(clips, 1, 1.5)).toBeNull();
    expect(preloadIndex(clips, 3, 1.5)).toBe(1);
    expect(preloadIndex(clips, 7, 1.5)).toBeNull();
  });
});

describe('캔버스 안 배치', () => {
  it('같은 비율은 캔버스를 꽉 채운다', () => {
    const b = contentBox(clip('a', 0, 1), { width: 1280, height: 720 });
    expect(b.widthPct).toBeCloseTo(100, 6);
    expect(b.heightPct).toBeCloseTo(100, 6);
  });

  it('세로 캔버스에 가로 영상은 위아래가 남는다', () => {
    const b = contentBox(clip('a', 0, 1), { width: 1080, height: 1920 });
    expect(b.widthPct).toBeCloseTo(100, 6);
    expect(b.heightPct).toBeCloseTo(((1080 * (1080 / 1920)) / 1920) * 100, 6);
  });

  it('90도 회전은 회전 뒤 크기로 맞추고, 반전은 회전 뒤에 적용한다', () => {
    const c = clip('a', 0, 1, { rotate: 90, flipH: true });
    const b = contentBox(c, { width: 1080, height: 1920 });
    // 회전 뒤 1080×1920 이 캔버스와 같으므로 회전 전 요소는 1920 너비 → 캔버스 너비 대비 177.78%
    expect(b.widthPct).toBeCloseTo((1920 / 1080) * 100, 4);
    expect(b.heightPct).toBeCloseTo((1080 / 1920) * 100, 4);
    expect(b.transform).toBe('translate(-50%, -50%) scale(-1, 1) rotate(90deg)');
  });
});

describe('필터와 텍스트·워터마크', () => {
  it('기본값이면 필터가 없고, 바뀐 값만 CSS 로 옮긴다', () => {
    expect(cssFilter({ brightness: 0, contrast: 1, saturation: 1, sharpen: 0.5, denoise: 0 })).toBe(
      'none',
    );
    expect(
      cssFilter({ brightness: 0.1, contrast: 1.2, saturation: 0, sharpen: 0, denoise: 0 }),
    ).toBe('brightness(1.100) contrast(1.200) saturate(0.000)');
  });

  const text: EditTextOverlay = {
    id: 't',
    text: '안녕',
    x: 'center',
    y: 'bottom',
    fontSize: 54,
    color: '#ffffff',
    boxed: true,
    startSec: 1,
    endSec: null,
  };

  it('텍스트 표시 구간은 렌더와 같다 (끝 null 이면 클립 끝까지, 빈 글자는 숨김)', () => {
    expect(textVisible(text, 0.5, 4)).toBe(false);
    expect(textVisible(text, 1, 4)).toBe(true);
    expect(textVisible(text, 4, 4)).toBe(true);
    expect(textVisible({ ...text, endSec: 2 }, 3, 4)).toBe(false);
    expect(textVisible({ ...text, text: '  ' }, 2, 4)).toBe(false);
  });

  it('텍스트 크기는 1080 기준을 상자 높이 비율로, 여백은 24픽셀로 옮긴다', () => {
    const s = textStyle(text, { width: 1920, height: 1080 });
    expect(s.fontSize).toBe('5.000cqh');
    expect(s.left).toBe('50%');
    expect(s.bottom).toBe(`${((24 / 1080) * 100).toFixed(3)}%`);
    expect(s.transform).toBe('translate(-50%, 0)');
    expect(s.background).toBe('rgba(0,0,0,0.5)');
  });

  it('워터마크는 캔버스 너비 대비 크기와 위치를 따른다', () => {
    const w = watermarkStyle(
      { path: '/w.png', fileName: 'w.png', position: 'bottomright', scale: 0.2, opacity: 0.7 },
      { width: 1920, height: 1080 },
    );
    expect(w.width).toBe('20.000%');
    expect(w.opacity).toBe(0.7);
    expect(w.right).toBe(`${((24 / 1920) * 100).toFixed(3)}%`);
  });
});

describe('음성과 배경 음악', () => {
  it('클립 음성: 음소거·음성 없음은 0, 음악이 있으면 원본 비율을 곱하고 1 을 넘지 않는다', () => {
    expect(clipGain(clip('a', 0, 1, { mute: true }), null)).toBe(0);
    expect(clipGain(clip('a', 0, 1, { hasAudio: false }), null)).toBe(0);
    expect(clipGain(clip('a', 0, 1, { volume: 1.6 }), music)).toBeCloseTo(0.8, 6);
    expect(clipGain(clip('a', 0, 1, { volume: 2 }), null)).toBe(1);
  });

  it('음악 위치: 반복이면 되풀이하고, 아니면 끝난 뒤 null', () => {
    expect(musicTimeAt(music, 12)).toBeCloseTo(2, 6);
    expect(musicTimeAt({ ...music, loop: false }, 12)).toBeNull();
    expect(musicTimeAt({ ...music, loop: false }, 3)).toBe(3);
  });

  it('음악 음량: 페이드 인·아웃을 반영한다', () => {
    expect(musicGain(music, 1, 20)).toBeCloseTo(0.4, 6);
    expect(musicGain(music, 10, 20)).toBeCloseTo(0.8, 6);
    expect(musicGain(music, 19, 20)).toBeCloseTo(0.4, 6);
  });

  it('어긋남 허용 폭은 배속에 비례한다', () => {
    expect(needsSeek(1, 1.2, 1)).toBe(false);
    expect(needsSeek(1, 1.5, 1)).toBe(true);
    expect(needsSeek(1, 1.5, 2)).toBe(false);
  });
});

describe('캔버스 규칙 공유', () => {
  it('렌더 계획과 미리보기가 같은 함수를 쓴다', () => {
    expect(mainResolveCanvas).toBe(resolveCanvas);
    const p = {
      canvas: { preset: 'auto' as const, fps: 'auto' as const },
      clips: [clip('a', 0, 1, { sourceWidth: 1921, sourceHeight: 1079, rotate: 90 })],
    };
    expect(resolveCanvas(p)).toEqual({ width: 1080, height: 1922, fps: 30 });
  });
});
