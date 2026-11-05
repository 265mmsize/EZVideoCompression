/** 원본 보정: 표시 크기(회전), 인터레이스 제거 필터 */
import { describe, expect, it } from 'vitest';
import { displaySize } from '../../src/shared/displayDims';
import { buildRenderPlan } from '../../src/main/services/edit/EditGraphBuilder';
import { newProject } from '../../src/main/services/edit/VideoEditService';
import type { EditClip } from '../../src/shared/types/domain';

describe('표시 크기', () => {
  it('90·270도 회전이면 가로와 세로를 바꾼다, 0·180도는 그대로', () => {
    expect(displaySize(1920, 1080, 90)).toEqual({ width: 1080, height: 1920 });
    expect(displaySize(1920, 1080, 270)).toEqual({ width: 1080, height: 1920 });
    expect(displaySize(1920, 1080, 180)).toEqual({ width: 1920, height: 1080 });
    expect(displaySize(1920, 1080, 0)).toEqual({ width: 1920, height: 1080 });
    expect(displaySize(1920, 1080, undefined)).toEqual({ width: 1920, height: 1080 });
    expect(displaySize(null, null, 90)).toEqual({ width: null, height: null });
  });
});

describe('인터레이스 제거 필터', () => {
  const OPTS = {
    canvas: { width: 1280, height: 720, fps: 30 },
    textDir: '/tmp/text',
    trfDir: '/tmp/trf',
    fontFile: null,
    nullSink: '/dev/null',
    pathSep: '/' as const,
  };
  function clip(over: Partial<EditClip> = {}): EditClip {
    return {
      id: 'c1',
      path: '/v/a.mp4',
      fileName: 'a.mp4',
      sourceDurationSec: 5,
      sourceWidth: 640,
      sourceHeight: 360,
      hasAudio: false,
      inSec: 0,
      outSec: 5,
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
  it('켜면 yadif 가 영상 체인 맨 앞에, 끄면 없다', () => {
    const on = buildRenderPlan(
      { ...newProject('보정', '2026-11-05T00:00:00.000Z'), clips: [clip({ deinterlace: true })] },
      OPTS,
    );
    expect(on.filterComplex).toContain('[0:v]yadif=mode=send_frame:parity=auto:deint=interlaced,');
    const off = buildRenderPlan(
      { ...newProject('보정', '2026-11-05T00:00:00.000Z'), clips: [clip({ deinterlace: false })] },
      OPTS,
    );
    expect(off.filterComplex).not.toContain('yadif');
  });
});
