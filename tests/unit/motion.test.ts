/** 메인 클립 움직임(켄번스·음량), 트랙 클립 배속·회전·필터, 트랙 간 이동, 키프레임 자르기 */
import { describe, expect, it } from 'vitest';
import { hasZoomPan, motionValue, sliceKeyframes, trackClipDur } from '../../src/shared/keyframes';
import { splitAt } from '../../src/renderer/pages/editOps';
import {
  cutOut,
  cutOutTracks,
  moveClipToTrack,
  trimEdge,
  trimTrackClip,
} from '../../src/renderer/pages/timelineOps';
import { cropOffsetRatio, motionStyle, trackVisual } from '../../src/renderer/pages/previewMath';
import { buildRenderPlan } from '../../src/main/services/edit/EditGraphBuilder';
import { newProject } from '../../src/main/services/edit/VideoEditService';
import type { EditClip, EditTrack, EditTrackClip } from '../../src/shared/types/domain';

let seq = 0;
const newId = (): string => `m${String(++seq)}`;

function clip(over: Partial<EditClip> = {}): EditClip {
  return {
    id: 'c1',
    path: '/v/a.mp4',
    fileName: 'a.mp4',
    sourceDurationSec: 100,
    sourceWidth: 1920,
    sourceHeight: 1080,
    hasAudio: true,
    inSec: 0,
    outSec: 8,
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

const zoomIn = {
  zoom: [
    { t: 0, v: 1 },
    { t: 8, v: 3 },
  ],
  panX: [],
  panY: [],
  volume: [],
};

function tclip(over: Partial<EditTrackClip> = {}): EditTrackClip {
  return {
    id: 't1',
    path: '/v/o.mp4',
    fileName: 'o.mp4',
    kind: 'video',
    sourceDurationSec: 100,
    sourceWidth: 200,
    sourceHeight: 100,
    hasAudio: true,
    startSec: 0,
    inSec: 0,
    outSec: 8,
    volume: 1,
    mute: false,
    x: 0.5,
    y: 0.5,
    scale: 0.25,
    opacity: 1,
    anim: { x: [], y: [], scale: [], opacity: [], volume: [] },
    ...over,
  };
}

describe('키프레임 자르기 (곡선 유지)', () => {
  const k = [
    { t: 0, v: 0 },
    { t: 4, v: 4 },
  ];
  it('구간 양 끝에 보간 값을 넣고 0 부터 시작하게 한다', () => {
    expect(sliceKeyframes(k, 1, 3)).toEqual([
      { t: 0, v: 1 },
      { t: 2, v: 3 },
    ]);
  });
  it('뒤를 자르지 않으면 마지막 키프레임까지 남긴다', () => {
    expect(sliceKeyframes(k, 1, Infinity)).toEqual([
      { t: 0, v: 1 },
      { t: 3, v: 4 },
    ]);
  });
  it('키프레임이 없으면 빈 배열', () => {
    expect(sliceKeyframes([], 1, 2)).toEqual([]);
  });
});

describe('메인 클립 움직임', () => {
  it('기본값은 확대 1, 초점 가운데, 음량은 클립 음량', () => {
    const c = clip({ volume: 0.7 });
    expect(motionValue(c, 'zoom', 3)).toBe(1);
    expect(motionValue(c, 'panX', 3)).toBe(0.5);
    expect(motionValue(c, 'volume', 3)).toBe(0.7);
    expect(hasZoomPan(c)).toBe(false);
    expect(hasZoomPan(clip({ motion: zoomIn }))).toBe(true);
  });

  it('나누면 조각마다 움직임이 이어진다 (배속 반영)', () => {
    const c = clip({ motion: zoomIn });
    const [a, b] = splitAt(c, [4], newId);
    expect(a?.motion?.zoom).toEqual([
      { t: 0, v: 1 },
      { t: 4, v: 2 },
    ]);
    expect(b?.motion?.zoom).toEqual([
      { t: 0, v: 2 },
      { t: 4, v: 3 },
    ]);
    // 배속 2: 원본 4초 = 클립 안 2초
    const fast = clip({
      speed: 2,
      motion: {
        ...zoomIn,
        zoom: [
          { t: 0, v: 1 },
          { t: 4, v: 3 },
        ],
      },
    });
    const [fa] = splitAt(fast, [4], newId);
    expect(fa?.motion?.zoom).toEqual([
      { t: 0, v: 1 },
      { t: 2, v: 2 },
    ]);
  });

  it('구간을 잘라도 앞·뒤 조각의 움직임이 원래 곡선을 따른다', () => {
    const out = cutOut([clip({ motion: zoomIn })], { startSec: 2, endSec: 6 }, newId);
    expect(out[0]?.motion?.zoom).toEqual([
      { t: 0, v: 1 },
      { t: 2, v: 1.5 },
    ]);
    expect(out[1]?.motion?.zoom).toEqual([
      { t: 0, v: 2.5 },
      { t: 2, v: 3 },
    ]);
  });

  it('시작을 줄이면 움직임이 당겨진다', () => {
    const t = trimEdge(clip({ motion: zoomIn }), 'in', 2);
    expect(t.inSec).toBe(2);
    expect(t.motion?.zoom).toEqual([
      { t: 0, v: 1.5 },
      { t: 6, v: 3 },
    ]);
  });
});

describe('트랙 클립 배속', () => {
  it('타임라인 길이는 원본 길이 ÷ 배속, 이미지는 배속을 쓰지 않는다', () => {
    expect(trackClipDur(tclip({ speed: 2 }))).toBe(4);
    expect(trackClipDur(tclip({ kind: 'image', speed: 2 }))).toBe(8);
  });

  it('배속 클립을 자르면 원본 시간은 배속만큼 움직인다', () => {
    const tracks: EditTrack[] = [
      { id: 'v', kind: 'video', name: '영상 1', enabled: true, clips: [tclip({ speed: 2 })] },
    ];
    // 타임라인 0~4초. 1~2초를 자르면 앞은 원본 0~2, 뒤는 원본 4~8
    const out = cutOutTracks(tracks, { startSec: 1, endSec: 2 }, newId)[0]?.clips ?? [];
    expect(out[0]).toMatchObject({ inSec: 0, outSec: 2 });
    expect(out[1]).toMatchObject({ startSec: 1, inSec: 4, outSec: 8 });
  });

  it('배속 클립의 가장자리 조절도 원본 시간으로 환산한다', () => {
    expect(trimTrackClip(tclip({ speed: 2 }), 'out', -1).outSec).toBe(6);
    expect(trimTrackClip(tclip({ speed: 2, startSec: 3 }), 'in', 1)).toMatchObject({
      startSec: 4,
      inSec: 2,
    });
  });
});

describe('트랙 간 이동', () => {
  const tracks: EditTrack[] = [
    { id: 'v1', kind: 'video', name: '영상 1', enabled: true, clips: [tclip()] },
    { id: 'v2', kind: 'video', name: '영상 2', enabled: true, clips: [] },
    { id: 'a1', kind: 'audio', name: '오디오 1', enabled: true, clips: [] },
  ];
  it('같은 종류 트랙으로 옮긴다', () => {
    const out = moveClipToTrack(tracks, 'v1', 'v2', 't1');
    expect(out[0]?.clips).toHaveLength(0);
    expect(out[1]?.clips.map((c) => c.id)).toEqual(['t1']);
  });
  it('종류가 다르거나 같은 트랙이면 그대로', () => {
    expect(moveClipToTrack(tracks, 'v1', 'a1', 't1')).toBe(tracks);
    expect(moveClipToTrack(tracks, 'v1', 'v1', 't1')).toBe(tracks);
    expect(moveClipToTrack(tracks, 'v1', 'v2', 'none')).toBe(tracks);
  });
});

describe('미리보기 배치', () => {
  it('초점 기준 확대는 렌더의 잘라 내기 위치와 같다', () => {
    for (const [z, p] of [
      [2, 0],
      [2, 1],
      [3, 0.25],
      [1.5, 0.5],
    ] as const) {
      // CSS: 기준점 p 에서 z 배 → 보이는 왼쪽 = p(1 - 1/z)
      const css = p * (1 - 1 / z);
      // 렌더: z 배로 키운 프레임에서 (zW-W)p 부터 W 만큼 → 원래 좌표 비율 = (zW-W)p / (zW)
      const render = ((z - 1) * p) / z;
      expect(cropOffsetRatio(z, p)).toBeCloseTo(css, 9);
      expect(cropOffsetRatio(z, p)).toBeCloseTo(render, 9);
    }
    const st = motionStyle(clip({ motion: zoomIn }), 4);
    expect(st).toEqual({ transform: 'scale(2.0000)', transformOrigin: '50.000% 50.000%' });
    expect(motionStyle(clip(), 4)).toBeNull();
  });

  it('90도 회전한 트랙 클립은 회전 후 너비가 크기 값과 같도록 요소 너비를 늘린다', () => {
    const v = trackVisual(tclip({ rotate: 90, flipH: true }), 0);
    expect(v.width).toBe('50.000%'); // 0.25 × 100 × (200/100)
    expect(v.transform).toBe('translate(-50%, -50%) scale(-1, 1) rotate(90deg)');
    expect(
      trackVisual(tclip({ filters: { brightness: 0.1, contrast: 1, saturation: 1 } }), 0).filter,
    ).toBe('brightness(1.100)');
  });
});

describe('렌더 계획', () => {
  const OPTS = {
    canvas: { width: 1280, height: 720, fps: 30 },
    textDir: '/tmp/text',
    trfDir: '/tmp/trf',
    fontFile: null,
    nullSink: '/dev/null',
    pathSep: '/' as const,
  };
  const base = newProject('움직임', '2026-11-04T00:00:00.000Z');

  it('확대·이동은 캔버스 맞춤 뒤, 밝기 보정과 텍스트 앞에 들어간다', () => {
    const c = clip({
      motion: { ...zoomIn, panX: [{ t: 0, v: 0 }] },
      filters: { brightness: 0.1, contrast: 1, saturation: 1, sharpen: 0, denoise: 0 },
      texts: [
        {
          id: 'x',
          text: '자막',
          x: 'center',
          y: 'bottom',
          fontSize: 48,
          color: '#ffffff',
          boxed: false,
          startSec: 0,
          endSec: null,
        },
      ],
    });
    const fc = buildRenderPlan({ ...base, clips: [c] }, OPTS).filterComplex;
    const fit = fc.indexOf('format=yuv420p');
    const zoom = fc.indexOf("scale=w='trunc(1280*max(1,");
    const crop = fc.indexOf("crop=1280:720:x='(in_w-1280)*clip(0.000,0,1)'");
    expect(fit).toBeGreaterThan(0);
    expect(zoom).toBeGreaterThan(fit);
    expect(crop).toBeGreaterThan(zoom);
    expect(fc.indexOf('eq=brightness')).toBeGreaterThan(crop);
    expect(fc.indexOf('drawtext=')).toBeGreaterThan(crop);
  });

  it('메인 클립 음량 키프레임은 배속 뒤 volume 식으로 들어간다', () => {
    const c = clip({
      speed: 2,
      motion: {
        zoom: [],
        panX: [],
        panY: [],
        volume: [
          { t: 0, v: 0 },
          { t: 1, v: 1 },
        ],
      },
    });
    const fc = buildRenderPlan({ ...base, clips: [c] }, OPTS).filterComplex;
    expect(fc).toContain("atempo=2.000,volume='if(lt(t,0.000),0.000");
    expect(fc).toContain(':eval=frame');
  });

  it('트랙 클립 배속·회전·반전·보정이 투명도 처리 앞에 순서대로 들어간다', () => {
    const tc = tclip({
      startSec: 1,
      inSec: 2,
      outSec: 6,
      speed: 2,
      rotate: 90,
      flipV: true,
      filters: { brightness: 0, contrast: 1.2, saturation: 1 },
    });
    const p = buildRenderPlan(
      {
        ...base,
        clips: [clip()],
        tracks: [{ id: 'v', kind: 'video', name: '영상 1', enabled: true, clips: [tc] }],
      },
      OPTS,
    );
    // 타임라인 2초 = 원본 4초를 읽는다
    expect(p.inputs[1]).toEqual(['-ss', '2.000', '-t', '4.000', '-i', '/v/o.mp4']);
    expect(p.filterComplex).toContain(
      '[1:v]setpts=(PTS-STARTPTS)/2.000+1.000/TB,transpose=1,vflip,eq=brightness=0.000:contrast=1.200:saturation=1.000,format=rgba',
    );
    expect(p.filterComplex).toContain('[1:a]asetpts=PTS-STARTPTS,atempo=2.000,aformat=');
  });
});
