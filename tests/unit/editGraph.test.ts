/**
 * 영상 편집 렌더 계획 (순수 로직): 길이·전환·속도·텍스트·음악·워터마크·손떨림 보정 인자
 */
import { describe, expect, it } from 'vitest';
import {
  atempoChain,
  buildRenderPlan,
  clipDurationSec,
  escapeFilterArg,
  locate,
  outputArgs,
  projectDurationSec,
  proxyCanvas,
  resolveCanvas,
} from '../../src/main/services/edit/EditGraphBuilder';
import { newProject } from '../../src/main/services/edit/VideoEditService';
import type { EditClip, EditProject } from '../../src/shared/types/domain';

function clip(over: Partial<EditClip> = {}): EditClip {
  return {
    id: over.id ?? 'c1',
    path: '/v/a.mp4',
    fileName: 'a.mp4',
    sourceDurationSec: 10,
    sourceWidth: 1920,
    sourceHeight: 1080,
    hasAudio: true,
    inSec: 0,
    outSec: 10,
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

function project(clips: EditClip[], over: Partial<EditProject> = {}): EditProject {
  return { ...newProject('테스트', '2026-10-29T00:00:00.000Z'), clips, ...over };
}

const OPTS = {
  canvas: { width: 1280, height: 720, fps: 30 },
  textDir: '/tmp/text',
  trfDir: '/tmp/trf',
  fontFile: null,
  nullSink: '/dev/null',
  pathSep: '/' as const,
};

describe('길이와 위치', () => {
  it('클립 길이는 (끝-시작)/속도, 전환은 겹친 만큼 전체 길이를 줄인다', () => {
    const a = clip({ inSec: 2, outSec: 8, speed: 2, transition: { type: 'fade', durationSec: 1 } });
    const b = clip({ id: 'c2', inSec: 0, outSec: 4 });
    expect(clipDurationSec(a)).toBe(3);
    expect(projectDurationSec(project([a, b]))).toBe(6); // 3 + 4 - 1
    // 전환은 양쪽 길이의 절반을 넘지 못한다
    const short = clip({ id: 'c3', inSec: 0, outSec: 1 });
    expect(projectDurationSec(project([a, short]))).toBe(3.5); // 3 + 1 - 0.5
  });

  it('프로젝트 시간을 클립과 원본 시간으로 바꾼다', () => {
    const a = clip({ inSec: 2, outSec: 8, speed: 2 }); // 3초
    const b = clip({ id: 'c2', inSec: 1, outSec: 5 }); // 4초
    expect(locate(project([a, b]), 1)).toEqual({ index: 0, sourceSec: 4 });
    expect(locate(project([a, b]), 3.5)).toEqual({ index: 1, sourceSec: 1.5 });
    const last = locate(project([a, b]), 100);
    expect(last?.index).toBe(1);
    expect(last?.sourceSec).toBeCloseTo(4.999, 3);
  });

  it('캔버스: auto 는 첫 클립(회전 반영)·짝수, 프리셋은 고정, 미리보기는 640 이하', () => {
    expect(
      resolveCanvas(project([clip({ sourceWidth: 1921, sourceHeight: 1079, rotate: 90 })])),
    ).toEqual({
      width: 1080,
      height: 1922,
      fps: 30,
    });
    expect(resolveCanvas(project([clip()], { canvas: { preset: '720p', fps: 60 } }))).toEqual({
      width: 1280,
      height: 720,
      fps: 60,
    });
    expect(proxyCanvas({ width: 1920, height: 1080, fps: 60 })).toEqual({
      width: 640,
      height: 360,
      fps: 30,
    });
    expect(proxyCanvas({ width: 480, height: 320, fps: 24 })).toEqual({
      width: 480,
      height: 320,
      fps: 24,
    });
  });

  it('atempo 는 0.5~2 범위로 쪼갠다', () => {
    expect(atempoChain(1)).toEqual(['atempo=1.000']);
    expect(atempoChain(2)).toEqual(['atempo=2.000']);
    expect(atempoChain(4)).toEqual(['atempo=2.000', 'atempo=2.000']);
    expect(atempoChain(3)).toEqual(['atempo=2.000', 'atempo=1.500']);
    expect(atempoChain(0.25)).toEqual(['atempo=0.500', 'atempo=0.500']);
    expect(atempoChain(0.4)).toEqual(['atempo=0.500', 'atempo=0.800']);
  });

  it('필터 인자 이스케이프: 역슬래시는 슬래시로, 콜론·쉼표·따옴표는 역슬래시로', () => {
    expect(escapeFilterArg('C:\\Users\\me\\a,b.txt')).toBe('C\\:/Users/me/a\\,b.txt');
    expect(escapeFilterArg("/tmp/it's")).toBe("/tmp/it\\'s");
  });
});

describe('렌더 계획', () => {
  it('클립 하나: 입력 탐색, 속도·캔버스 맞춤·텍스트, 음성 길이 고정', () => {
    const c = clip({
      inSec: 1,
      outSec: 5,
      speed: 2,
      volume: 0.5,
      texts: [
        {
          id: 't',
          text: '안녕',
          x: 'center',
          y: 'bottom',
          fontSize: 48,
          color: '#ffcc00',
          boxed: true,
          startSec: 0.5,
          endSec: null,
        },
      ],
    });
    const plan = buildRenderPlan(project([c]), OPTS);
    expect(plan.inputs).toEqual([['-ss', '1.000', '-t', '4.000', '-i', '/v/a.mp4']]);
    expect(plan.durationSec).toBe(2);
    expect(plan.textFiles).toEqual([{ file: '/tmp/text/clip-0-text-0.txt', content: '안녕' }]);
    const [vchain, achain] = plan.filterComplex.split(';');
    expect(vchain).toContain(
      "[0:v]setpts=(PTS-STARTPTS)/2.000,trim=duration=2.000,scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p,drawtext=textfile=/tmp/text/clip-0-text-0.txt:font=Sans:fontsize=32:fontcolor=0xFFCC00:x=(w-text_w)/2:y=h-text_h-24:enable='between(t,0.500,2.000)':box=1:boxcolor=black@0.5:boxborderw=7[v0]",
    );
    expect(achain).toBe(
      '[0:a]asetpts=PTS-STARTPTS,atempo=2.000,volume=0.500,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,apad=whole_dur=2.000,atrim=0:2.000[a0]',
    );
    expect(plan.videoLabel).toBe('v0');
    expect(plan.audioLabel).toBe('a0');
    expect(plan.stabilizePasses).toHaveLength(0);
  });

  it('음성 없는 클립은 무음을 만들고, 전환 없음은 concat, 전환은 xfade+acrossfade 로 잇는다', () => {
    const a = clip({ inSec: 0, outSec: 4, hasAudio: false });
    const b = clip({
      id: 'c2',
      inSec: 0,
      outSec: 4,
      transition: { type: 'wipeleft', durationSec: 1 },
    });
    const c = clip({ id: 'c3', inSec: 0, outSec: 2, mute: true });
    const plan = buildRenderPlan(project([a, b, c]), OPTS);
    const fc = plan.filterComplex;
    expect(fc).toContain('anullsrc=r=48000:cl=stereo:d=4.000[a0]');
    expect(fc).toContain('anullsrc=r=48000:cl=stereo:d=2.000[a2]');
    expect(fc).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vx1][ax1]');
    expect(fc).toContain('[vx1][v2]xfade=transition=wipeleft:duration=1.000:offset=7.000[vx2]');
    expect(fc).toContain('[ax1][a2]acrossfade=d=1.000:c1=tri:c2=tri[ax2]');
    expect(plan.durationSec).toBe(9);
    expect(plan.videoLabel).toBe('vx2');
  });

  it('배경 음악은 반복·자르기·페이드 후 amix, 워터마크는 overlay 로 붙는다', () => {
    const p = project([clip({ inSec: 0, outSec: 6 })], {
      music: {
        path: '/m/bgm.mp3',
        fileName: 'bgm.mp3',
        sourceDurationSec: 3,
        volume: 0.6,
        fadeInSec: 1,
        fadeOutSec: 2,
        loop: true,
        originalMix: 0.3,
      },
      watermark: {
        path: '/w/logo.png',
        fileName: 'logo.png',
        position: 'bottomright',
        scale: 0.2,
        opacity: 0.5,
      },
    });
    const plan = buildRenderPlan(p, OPTS);
    expect(plan.inputs).toEqual([
      ['-ss', '0.000', '-t', '6.000', '-i', '/v/a.mp4'],
      ['-i', '/m/bgm.mp3'],
      ['-i', '/w/logo.png'],
    ]);
    const fc = plan.filterComplex;
    expect(fc).toContain(
      '[1:a]aloop=loop=-1:size=2147483647,atrim=0:6.000,asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=0.600,afade=t=in:st=0:d=1.000,afade=t=out:st=4.000:d=2.000[am]',
    );
    expect(fc).toContain('[a0]volume=0.300[acm]');
    expect(fc).toContain(
      '[acm][am]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]',
    );
    expect(fc).toContain(
      '[2:v]format=rgba,scale=256:-1:flags=lanczos,colorchannelmixer=aa=0.500[wm]',
    );
    expect(fc).toContain(
      '[v0][wm]overlay=main_w-overlay_w-24:main_h-overlay_h-24:format=auto[vout]',
    );
    expect(plan.videoLabel).toBe('vout');
    expect(plan.audioLabel).toBe('aout');
    expect(plan.notes).toHaveLength(2);
  });

  it('손떨림 보정은 분석 패스를 만들고 변환 필터를 체인 맨 앞에 둔다', () => {
    const plan = buildRenderPlan(
      project([clip({ inSec: 1, outSec: 3, stabilize: true, rotate: 180, flipV: true })]),
      OPTS,
    );
    expect(plan.stabilizePasses).toHaveLength(1);
    const pass = plan.stabilizePasses[0]!;
    expect(pass.trfFile).toBe('/tmp/trf/clip-0.trf');
    expect(pass.args).toEqual(
      expect.arrayContaining([
        '-ss',
        '1.000',
        '-t',
        '2.000',
        '-i',
        '/v/a.mp4',
        '-vf',
        'vidstabdetect=result=/tmp/trf/clip-0.trf:shakiness=5:accuracy=15',
        '-f',
        'null',
        '/dev/null',
      ]),
    );
    expect(
      plan.filterComplex.startsWith(
        '[0:v]vidstabtransform=input=/tmp/trf/clip-0.trf:smoothing=10:zoom=0:optzoom=1,unsharp=5:5:0.8:3:3:0.4,setpts=',
      ),
    ).toBe(true);
    expect(plan.filterComplex).toContain('transpose=1,transpose=1,vflip,scale=');
  });

  it('출력 인자: 미리보기는 ultrafast, 내보내기는 코덱·CRF·프리셋, MP4 HEVC 는 hvc1', () => {
    expect(
      outputArgs('proxy', { container: 'mp4', codec: 'hevc', crf: 20, preset: 'slow' }),
    ).toEqual([
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
    ]);
    expect(
      outputArgs('export', { container: 'mp4', codec: 'hevc', crf: 24, preset: 'slow' }),
    ).toEqual([
      '-c:v',
      'libx265',
      '-preset',
      'slow',
      '-crf',
      '24',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-tag:v',
      'hvc1',
      '-movflags',
      '+faststart',
    ]);
    expect(
      outputArgs('export', { container: 'mkv', codec: 'h264', crf: 18, preset: 'medium' }),
    ).toEqual([
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
    ]);
  });
});
