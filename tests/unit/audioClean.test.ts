/** 소리 정리 필터: 잡음 줄이기, 보컬 채널 연산, 모노 거부, 렌더 계획의 위치 */
import { describe, expect, it } from 'vitest';
import {
  audioCleanFilters,
  noiseFilter,
  vocalAvailability,
  vocalFilter,
} from '../../src/shared/audioClean';
import { buildRenderPlan } from '../../src/main/services/edit/EditGraphBuilder';
import { newProject } from '../../src/main/services/edit/VideoEditService';
import type { EditClip } from '../../src/shared/types/domain';

describe('소리 정리 필터', () => {
  it('잡음 줄이기는 약하게 12dB, 강하게 24dB 의 afftdn', () => {
    expect(noiseFilter('off')).toBeNull();
    expect(noiseFilter('light')).toBe('afftdn=nr=12:nf=-30');
    expect(noiseFilter('strong')).toBe('afftdn=nr=24:nf=-30');
  });

  it('보컬 처리는 스테레오에서만: 줄이기는 좌우 차이, 가운데 남기기는 좌우 평균', () => {
    expect(vocalFilter('reduce', 2)).toBe('pan=stereo|c0=c0-c1|c1=c0-c1');
    expect(vocalFilter('isolate', 2)).toBe('pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1');
    expect(vocalFilter('reduce', 1)).toBeNull();
    expect(vocalFilter('isolate', null)).toBeNull();
    expect(vocalFilter('off', 2)).toBeNull();
  });

  it('모노나 채널 정보가 없으면 보컬 옵션을 막고 이유를 알린다', () => {
    expect(vocalAvailability(2)).toEqual({ ok: true, reason: null });
    expect(vocalAvailability(1).ok).toBe(false);
    expect(vocalAvailability(null).reason).toContain('알 수 없습니다');
  });

  it('잡음 다음에 보컬 순서로 정리 필터를 만든다 (모노면 보컬은 빠진다)', () => {
    expect(audioCleanFilters({ noiseReduce: 'light', vocal: 'reduce', audioChannels: 2 })).toEqual([
      'pan=stereo|c0=c0-c1|c1=c0-c1',
      'afftdn=nr=12:nf=-30',
    ]);
    expect(audioCleanFilters({ noiseReduce: 'strong', vocal: 'reduce', audioChannels: 1 })).toEqual(
      ['afftdn=nr=24:nf=-30'],
    );
    expect(audioCleanFilters({})).toEqual([]);
  });
});

describe('렌더 계획의 소리 정리 위치', () => {
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
      hasAudio: true,
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

  it('정리 필터는 배속 뒤, 볼륨 앞에 들어간다', () => {
    const p = buildRenderPlan(
      {
        ...newProject('소리', '2026-11-04T00:00:00.000Z'),
        clips: [clip({ speed: 2, noiseReduce: 'light', vocal: 'isolate', audioChannels: 2 })],
      },
      OPTS,
    );
    const fc = p.filterComplex;
    const atempo = fc.indexOf('atempo=2.000');
    const pan = fc.indexOf('pan=stereo|c0=0.5*c0+0.5*c1');
    const afftdn = fc.indexOf('afftdn=nr=12');
    const volume = fc.indexOf('volume=1.000');
    expect(atempo).toBeGreaterThan(0);
    expect(pan).toBeGreaterThan(atempo);
    expect(afftdn).toBeGreaterThan(pan);
    expect(volume).toBeGreaterThan(afftdn);
  });

  it('소리 정리를 끄면 필터가 없다', () => {
    const p = buildRenderPlan(
      { ...newProject('소리', '2026-11-04T00:00:00.000Z'), clips: [clip({ audioChannels: 2 })] },
      OPTS,
    );
    expect(p.filterComplex).not.toContain('afftdn');
    expect(p.filterComplex).not.toContain('pan=stereo');
  });
});
