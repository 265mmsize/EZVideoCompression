/** 키프레임: 화면 값과 FFmpeg 식이 같은 규칙을 따르는지, 렌더 계획의 추가 트랙 단계 */
import { describe, expect, it } from 'vitest';
import {
  animValue,
  hasKeyframeNear,
  keyframeExpr,
  normalizeKeyframes,
  removeKeyframeNear,
  shiftKeyframes,
  upsertKeyframe,
  valueAt,
} from '../../src/shared/keyframes';
import { buildRenderPlan } from '../../src/main/services/edit/EditGraphBuilder';
import { newProject } from '../../src/main/services/edit/VideoEditService';
import type {
  EditClip,
  EditKeyframe,
  EditTrack,
  EditTrackClip,
} from '../../src/shared/types/domain';

/**
 * FFmpeg 식의 부분집합(숫자, t, 괄호, 사칙연산, 단항 -, if(c,a,b), lt(a,b))을 계산하는 작은 파서.
 * 코드를 실행하지 않고 직접 해석한다.
 */
function evalExpr(expr: string, t: number): number {
  const src = expr.replace(/\s+/g, '');
  let i = 0;
  const peek = (): string => src[i] ?? '';
  const eat = (ch: string): void => {
    if (src[i] !== ch) throw new Error(`'${ch}' 가 필요합니다 (${String(i)}): ${src}`);
    i++;
  };
  const parseExpr = (): number => {
    let v = parseTerm();
    while (peek() === '+' || peek() === '-') {
      const op = src[i++];
      const r = parseTerm();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = (): number => {
    let v = parseFactor();
    while (peek() === '*' || peek() === '/') {
      const op = src[i++];
      const r = parseFactor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const parseArgs = (): number[] => {
    eat('(');
    const args = [parseExpr()];
    while (peek() === ',') {
      i++;
      args.push(parseExpr());
    }
    eat(')');
    return args;
  };
  const parseFactor = (): number => {
    if (peek() === '-') {
      i++;
      return -parseFactor();
    }
    if (peek() === '(') {
      i++;
      const v = parseExpr();
      eat(')');
      return v;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const id = /^[a-z]+/.exec(src.slice(i))?.[0] ?? '';
    i += id.length;
    if (id === 't') return t;
    const args = parseArgs();
    if (id === 'if') return args[0] ? (args[1] ?? 0) : (args[2] ?? 0);
    if (id === 'lt') return (args[0] ?? 0) < (args[1] ?? 0) ? 1 : 0;
    throw new Error(`모르는 함수: ${id}`);
  };
  const v = parseExpr();
  if (i !== src.length) throw new Error(`남은 글자: ${src.slice(i)}`);
  return v;
}

const kfs: EditKeyframe[] = [
  { t: 1, v: 0.2 },
  { t: 3, v: 0.8 },
  { t: 4, v: 0.5 },
];

describe('키프레임 값', () => {
  it('첫 키프레임 앞은 첫 값, 사이는 직선, 마지막 뒤는 마지막 값', () => {
    expect(valueAt(kfs, 0, 9)).toBe(0.2);
    expect(valueAt(kfs, 2, 9)).toBeCloseTo(0.5, 9);
    expect(valueAt(kfs, 3.5, 9)).toBeCloseTo(0.65, 9);
    expect(valueAt(kfs, 10, 9)).toBe(0.5);
    expect(valueAt([], 2, 0.7)).toBe(0.7);
  });

  it('정렬하고 가까운 시점은 하나로 합친다', () => {
    expect(
      normalizeKeyframes([
        { t: 2, v: 1 },
        { t: 1, v: 0 },
        { t: 2.01, v: 3 },
      ]),
    ).toEqual([
      { t: 1, v: 0 },
      { t: 2, v: 3 },
    ]);
  });

  it('넣기·바꾸기·지우기', () => {
    const a = upsertKeyframe([], 1, 0.5);
    const b = upsertKeyframe(a, 1.02, 0.9);
    expect(b).toEqual([{ t: 1, v: 0.9 }]);
    expect(hasKeyframeNear(b, 1.03)).toBe(true);
    expect(removeKeyframeNear(b, 1)).toEqual([]);
  });

  it('클립 앞을 자르면 키프레임을 당기고 범위 밖은 버린다', () => {
    expect(shiftKeyframes(kfs, -2, 5)).toEqual([
      { t: 1, v: 0.8 },
      { t: 2, v: 0.5 },
    ]);
  });
});

describe('FFmpeg 식', () => {
  it('키프레임이 없거나 하나면 고정 값', () => {
    expect(keyframeExpr([], 0.25, 't')).toBe('0.250');
    expect(keyframeExpr([{ t: 2, v: 0.4 }], 0.25, 't')).toBe('0.400');
  });

  it('여러 시점에서 화면 값과 같은 결과를 낸다', () => {
    const e = keyframeExpr(kfs, 0, '(t-0.000)');
    for (const t of [0, 0.5, 1, 1.5, 2, 2.9, 3, 3.2, 3.99, 4, 7]) {
      expect(evalExpr(e, t)).toBeCloseTo(valueAt(kfs, t, 0), 6);
    }
  });

  it('클립 시작이 옮겨진 식도 같은 결과', () => {
    const e = keyframeExpr(kfs, 0, '(t-10.000)');
    expect(evalExpr(e, 12)).toBeCloseTo(valueAt(kfs, 2, 0), 6);
  });
});

function mainClip(over: Partial<EditClip> = {}): EditClip {
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

function trackClip(over: Partial<EditTrackClip> = {}): EditTrackClip {
  return {
    id: 't1',
    path: '/v/logo.png',
    fileName: 'logo.png',
    kind: 'image',
    sourceDurationSec: 86_400,
    sourceWidth: 200,
    sourceHeight: 100,
    hasAudio: false,
    startSec: 1,
    inSec: 0,
    outSec: 3,
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

const OPTS = {
  canvas: { width: 1280, height: 720, fps: 30 },
  textDir: '/tmp/text',
  trfDir: '/tmp/trf',
  fontFile: null,
  nullSink: '/dev/null',
  pathSep: '/' as const,
};

function plan(tracks: EditTrack[]) {
  return buildRenderPlan(
    { ...newProject('트랙', '2026-11-04T00:00:00.000Z'), clips: [mainClip()], tracks },
    OPTS,
  );
}

describe('렌더 계획의 추가 트랙', () => {
  it('이미지 오버레이는 반복 입력, 시작 위치로 옮긴 시간, 표시 구간으로 겹친다', () => {
    const p = plan([
      { id: 'v', kind: 'video', name: '영상 1', enabled: true, clips: [trackClip()] },
    ]);
    expect(p.inputs[1]).toEqual([
      '-loop',
      '1',
      '-framerate',
      '30',
      '-t',
      '3.000',
      '-i',
      '/v/logo.png',
    ]);
    expect(p.filterComplex).toContain('[1:v]setpts=PTS-STARTPTS+1.000/TB,format=rgba,scale=320:-2');
    expect(p.filterComplex).toContain("enable='between(t,1.000,4.000)'");
    expect(p.filterComplex).toContain("x='main_w*(0.500)-overlay_w/2'");
    expect(p.videoLabel).toBe('vt0');
  });

  it('키프레임이 있으면 투명도는 geq, 크기는 프레임마다, 위치는 식으로 바뀐다', () => {
    const tc = trackClip({
      anim: {
        x: [
          { t: 0, v: 0.2 },
          { t: 2, v: 0.8 },
        ],
        y: [],
        scale: [
          { t: 0, v: 0.1 },
          { t: 2, v: 0.4 },
        ],
        opacity: [
          { t: 0, v: 0 },
          { t: 1, v: 1 },
        ],
        volume: [],
      },
    });
    const fc = plan([
      { id: 'v', kind: 'video', name: '영상 1', enabled: true, clips: [tc] },
    ]).filterComplex;
    // 투명도(geq)가 크기(scale eval=frame)보다 앞에 온다
    expect(fc.indexOf('geq=')).toBeGreaterThan(0);
    expect(fc.indexOf('geq=')).toBeLessThan(fc.indexOf('eval=frame:flags=bilinear'));
    expect(fc).toContain('(T-1.000)');
    expect(fc).toContain('if(lt((t-1.000),2.000)');
  });

  it('꺼진 트랙과 메인 길이 밖의 클립은 빠지고, 길이를 넘는 부분은 잘린다', () => {
    const off = plan([
      { id: 'v', kind: 'video', name: '영상 1', enabled: false, clips: [trackClip()] },
    ]);
    expect(off.inputs).toHaveLength(1);
    const late = plan([
      {
        id: 'v',
        kind: 'video',
        name: '영상 1',
        enabled: true,
        clips: [trackClip({ startSec: 7 })],
      },
    ]);
    expect(late.inputs).toHaveLength(1);
    const cut = plan([
      {
        id: 'v',
        kind: 'video',
        name: '영상 1',
        enabled: true,
        clips: [trackClip({ startSec: 5 })],
      },
    ]);
    expect(cut.inputs[1]).toContain('1.000');
  });

  it('오디오 트랙은 시작만큼 늦추고 음량 키프레임을 식으로 넣어 원래 음성과 섞는다', () => {
    const audio = trackClip({
      id: 'a1',
      path: '/a/voice.mp3',
      fileName: 'voice.mp3',
      kind: 'audio',
      sourceDurationSec: 10,
      sourceWidth: 0,
      sourceHeight: 0,
      hasAudio: true,
      startSec: 2.5,
      inSec: 1,
      outSec: 4,
      anim: {
        x: [],
        y: [],
        scale: [],
        opacity: [],
        volume: [
          { t: 0, v: 0 },
          { t: 1, v: 1 },
        ],
      },
    });
    const p = plan([{ id: 'a', kind: 'audio', name: '오디오 1', enabled: true, clips: [audio] }]);
    expect(p.inputs[1]).toEqual(['-ss', '1.000', '-t', '3.000', '-i', '/a/voice.mp3']);
    expect(p.filterComplex).toContain("volume='if(lt(t,0.000)");
    expect(p.filterComplex).toContain('adelay=2500:all=1[ta0]');
    expect(p.filterComplex).toContain('amix=inputs=2');
    expect(p.audioLabel).toBe('atr');
    // 오디오 트랙에는 화면 오버레이가 없다
    expect(p.filterComplex).not.toContain('overlay=x=');
  });

  it('클립 안 시간 값', () => {
    const tc = trackClip({
      anim: {
        x: [
          { t: 0, v: 0 },
          { t: 2, v: 1 },
        ],
        y: [],
        scale: [],
        opacity: [],
        volume: [],
      },
    });
    expect(animValue(tc, 'x', 1)).toBeCloseTo(0.5, 9);
    expect(animValue(tc, 'y', 1)).toBe(0.5);
  });
});
