/** 클립 편집 마무리: 시간 규칙, 페이드, 프레임 고정, 복사, 렌더 필터 순서, 미리보기 페이드 */
import { describe, expect, it } from 'vitest';
import {
  clipDuration,
  clipLabel,
  fadeFactor,
  FREEZE_DEFAULT_SEC,
  FREEZE_FRAME_SEC,
  maxFadeSec,
} from '../../src/shared/clipTime';
import { copyOf, freezeAt } from '../../src/renderer/pages/clipEdits';
import { layersAt } from '../../src/renderer/pages/previewMath';
import { thumbCount, thumbTimes } from '../../src/renderer/pages/thumbMath';
import { buildRenderPlan } from '../../src/main/services/edit/EditGraphBuilder';
import { newProject } from '../../src/main/services/edit/VideoEditService';
import type { EditClip } from '../../src/shared/types/domain';

let seq = 0;
const newId = (): string => `k${String(++seq)}`;

function clip(over: Partial<EditClip> = {}): EditClip {
  return {
    id: 'c1',
    path: '/v/a.mp4',
    fileName: 'a.mp4',
    sourceDurationSec: 10,
    sourceWidth: 1920,
    sourceHeight: 1080,
    hasAudio: true,
    inSec: 0,
    outSec: 6,
    speed: 1,
    volume: 1,
    mute: false,
    rotate: 0,
    flipH: false,
    flipV: false,
    filters: { brightness: 0, contrast: 1, saturation: 1, sharpen: 0, denoise: 0 },
    stabilize: false,
    transition: { type: 'none', durationSec: 1 },
    texts: [],
    ...over,
  };
}

describe('클립 시간 규칙', () => {
  it('보통 클립은 구간 ÷ 배속, 고정 클립은 고정 길이', () => {
    expect(clipDuration(clip({ speed: 2 }))).toBe(3);
    expect(clipDuration(clip({ still: true, stillSec: 4 }))).toBe(4);
    expect(clipDuration(clip({ still: true }))).toBe(FREEZE_DEFAULT_SEC);
  });

  it('이름은 바꾼 이름이 있으면 그것, 공백이면 파일 이름', () => {
    expect(clipLabel(clip({ label: '  인트로 ' }))).toBe('인트로');
    expect(clipLabel(clip({ label: '   ' }))).toBe('a.mp4');
    expect(clipLabel(clip())).toBe('a.mp4');
  });

  it('페이드는 인에서 0→1, 아웃에서 1→0, 최대 길이는 클립의 절반', () => {
    const c = { fadeInSec: 1, fadeOutSec: 2 };
    expect(fadeFactor(c, 0, 6)).toBe(0);
    expect(fadeFactor(c, 0.5, 6)).toBeCloseTo(0.5, 9);
    expect(fadeFactor(c, 3, 6)).toBe(1);
    expect(fadeFactor(c, 5, 6)).toBeCloseTo(0.5, 9);
    expect(fadeFactor(c, 6, 6)).toBe(0);
    expect(maxFadeSec(6)).toBe(3);
  });
});

describe('프레임 고정', () => {
  it('앞·고정·뒤 세 조각으로 나누고, 고정 조각은 소리 없이 한 프레임을 멈춘다', () => {
    const c = clip({ id: 'base', label: '장면', fadeInSec: 0.5, fadeOutSec: 0.5, texts: [] });
    const pieces = freezeAt(c, 2, newId, 3);
    expect(pieces).toHaveLength(3);
    const [head, still, tail] = pieces as [EditClip, EditClip, EditClip];
    expect(head).toMatchObject({ id: 'base', inSec: 0, outSec: 2, fadeOutSec: 0, fadeInSec: 0.5 });
    expect(still).toMatchObject({
      still: true,
      stillSec: 3,
      label: '장면 (고정)',
      inSec: 2,
      outSec: 2 + FREEZE_FRAME_SEC,
      mute: true,
      speed: 1,
    });
    expect(still.id).not.toBe('base');
    expect(tail).toMatchObject({ inSec: 2, outSec: 6, fadeInSec: 0, fadeOutSec: 0.5 });
    expect(tail.id).not.toBe('base');
  });

  it('배속 클립은 원본 시각으로 자른다 (재생 헤드는 결과 시간)', () => {
    const c = clip({ speed: 2, inSec: 0, outSec: 6 });
    // 결과 1초 지점 = 원본 2초
    const pieces = freezeAt(c, 2, newId) as EditClip[];
    expect(pieces[0]?.outSec).toBe(2);
  });

  it('가장자리에 너무 가깝거나 이미 고정 클립이면 나누지 않는다', () => {
    const c = clip();
    expect(freezeAt(c, 0.05, newId)).toBeNull();
    expect(freezeAt(c, 5.95, newId)).toBeNull();
    expect(freezeAt(clip({ still: true, stillSec: 2 }), 2, newId)).toBeNull();
  });
});

describe('복사', () => {
  it('붙여넣기 복사본은 새 id, 전환은 없음, 나머지 설정은 그대로', () => {
    const c = clip({ transition: { type: 'fade', durationSec: 1 }, label: '복사할 것' });
    const copy = copyOf(c, newId);
    expect(copy.id).not.toBe(c.id);
    expect(copy.transition.type).toBe('none');
    expect(copy.label).toBe('복사할 것');
    expect(copy.inSec).toBe(c.inSec);
  });
});

describe('썸네일', () => {
  it('폭에 맞춰 1~12개, 고정 클립은 한 프레임', () => {
    expect(thumbCount(10)).toBe(1);
    expect(thumbCount(1000)).toBe(12);
    expect(thumbTimes(clip({ still: true, inSec: 2 }), 5)).toEqual([2]);
    const t = thumbTimes(clip({ inSec: 0, outSec: 4 }), 2);
    expect(t).toEqual([1, 3]);
  });
});

describe('렌더 계획의 클립 페이드와 고정 프레임', () => {
  const OPTS = {
    canvas: { width: 1280, height: 720, fps: 30 },
    textDir: '/tmp/text',
    trfDir: '/tmp/trf',
    fontFile: null,
    nullSink: '/dev/null',
    pathSep: '/' as const,
  };
  const base = newProject('마무리', '2026-11-04T00:00:00.000Z');

  it('페이드는 영상 fade 와 소리 afade 로 들어가고 텍스트 뒤, 클립 끝에 있다', () => {
    const p = buildRenderPlan({ ...base, clips: [clip({ fadeInSec: 1, fadeOutSec: 1.5 })] }, OPTS);
    expect(p.filterComplex).toContain('fade=t=in:st=0:d=1.000');
    expect(p.filterComplex).toContain('fade=t=out:st=4.500:d=1.500');
    expect(p.filterComplex).toContain('afade=t=in:st=0:d=1.000');
    expect(p.filterComplex).toContain('afade=t=out:st=4.500:d=1.500');
  });

  it('고정 클립은 한 프레임을 반복하고 소리 대신 무음을 넣는다', () => {
    const still = clip({
      still: true,
      stillSec: 2.5,
      inSec: 1,
      outSec: 1 + FREEZE_FRAME_SEC,
      mute: true,
    });
    const p = buildRenderPlan({ ...base, clips: [still] }, OPTS);
    expect(p.inputs[0]).toEqual(['-ss', '1.000', '-t', '0.033', '-i', '/v/a.mp4']);
    expect(p.filterComplex).toContain('loop=loop=-1:size=1:start=0');
    expect(p.filterComplex).toContain('trim=duration=2.500');
    expect(p.filterComplex).toContain('anullsrc=r=48000:cl=stereo:d=2.500');
    expect(p.durationSec).toBeCloseTo(2.5, 6);
  });
});

describe('미리보기의 페이드', () => {
  it('클립 페이드가 불투명도(영상과 소리)에 곱해진다', () => {
    const p = newProject('미리보기', '2026-11-04T00:00:00.000Z');
    const c = clip({ fadeInSec: 2 });
    const layers = layersAt({ ...p, clips: [c] }.clips, 1);
    expect(layers[0]?.opacity).toBeCloseTo(0.5, 9);
    expect(layersAt([c], 3)[0]?.opacity).toBe(1);
  });
});
