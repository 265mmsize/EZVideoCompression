import { describe, expect, it } from 'vitest';
import type {
  AnalysisResult,
  JobSettings,
  ProbeResult,
  ProbeStream,
} from '../../src/shared/types/domain';
import {
  analyzeCapability,
  computeTargetBudget,
  bytesPerMiB,
  CONTAINER_OVERHEAD_RATIO,
} from '../../src/main/services/CapabilityService';
import {
  buildEncodePlan,
  BASE_CRF,
  FAST_CRF,
  encoderFor,
} from '../../src/main/services/CompressionPolicyService';

const C = { value: null, source: 'unknown' } as const;
const conf = (v: number) => ({ value: v, source: 'confirmed' as const });

function video(over: Partial<ProbeStream> = {}): ProbeStream {
  return {
    index: 0,
    kind: 'video',
    codecName: 'h264',
    codecLongName: null,
    language: null,
    title: null,
    isDefault: true,
    isAttachedPic: false,
    width: 1920,
    height: 1080,
    pixFmt: 'yuv420p',
    bitDepth: 8,
    hasAlpha: false,
    fieldOrder: 'progressive',
    avgFrameRate: conf(30),
    nominalFrameRate: conf(30),
    rotation: 0,
    colorSpace: null,
    colorRange: null,
    colorTransfer: null,
    colorPrimaries: null,
    hasDolbyVision: false,
    bitRate: conf(8_000_000),
    channels: null,
    channelLayout: null,
    sampleRate: null,
    durationSec: conf(60),
    startTimeSec: 0,
    timeBase: '1/30000',
    disposition: {},
    ...over,
  };
}
function audio(index: number, codec = 'aac', over: Partial<ProbeStream> = {}): ProbeStream {
  return {
    ...video(),
    index,
    kind: 'audio',
    codecName: codec,
    width: null,
    height: null,
    pixFmt: null,
    bitDepth: null,
    avgFrameRate: C,
    nominalFrameRate: C,
    bitRate: conf(192_000),
    channels: 2,
    sampleRate: 48000,
    isDefault: false,
    ...over,
  };
}
function probe(streams: ProbeStream[], dur: number | null = 60): ProbeResult {
  return {
    path: '/x/in.mp4',
    fileName: 'in.mp4',
    sizeBytes: 100_000_000,
    mtimeMs: 1,
    formatName: 'mov,mp4',
    durationSec: dur === null ? C : conf(dur),
    bitRate: C,
    streams,
    chapters: [],
  };
}
const S = (over: Partial<JobSettings> = {}): JobSettings => ({
  mode: 'quality',
  preset: 'compatibility',
  container: 'mp4',
  codec: 'h264',
  targetMiB: null,
  videoStreamIndex: null,
  crf: null,
  ...over,
});

describe('CapabilityService 판정', () => {
  it('일반 SDR H.264 는 지원 상태다', () => {
    const a = analyzeCapability(probe([video(), audio(1)]), S());
    expect(a.support).toBe('supported');
    expect(a.tracks.find((t) => t.kind === 'audio')?.action).toBe('copy');
  });

  it('HDR 전달 특성은 재인코딩에서 차단되고 복사 모드에서는 경고만 남는다', () => {
    const p = probe([video({ colorTransfer: 'smpte2084' })]);
    expect(analyzeCapability(p, S()).support).toBe('blocked');
    expect(analyzeCapability(p, S({ mode: 'copy', container: 'mkv' })).support).toBe('limited');
  });

  it('알파 채널과 인터레이스는 재인코딩을 차단한다', () => {
    expect(analyzeCapability(probe([video({ hasAlpha: true })]), S()).support).toBe('blocked');
    expect(analyzeCapability(probe([video({ fieldOrder: 'interlaced' })]), S()).support).toBe(
      'blocked',
    );
  });

  it('10비트 영상을 H.264 로 바꾸는 것은 차단한다 (조용한 8비트 변환 금지)', () => {
    const r = analyzeCapability(
      probe([video({ bitDepth: 10, pixFmt: 'yuv420p10le' })]),
      S({ codec: 'h264' }),
    );
    expect(r.support).toBe('blocked');
    expect(r.limitations.map((l) => l.code)).toContain('BITDEPTH_H264');
  });

  it('MP4 출력에서 이미지 자막은 사유와 함께 제외된다', () => {
    const sub: ProbeStream = {
      ...video(),
      index: 2,
      kind: 'subtitle',
      codecName: 'hdmv_pgs_subtitle',
      width: null,
      height: null,
      pixFmt: null,
      bitDepth: null,
      avgFrameRate: C,
      nominalFrameRate: C,
      bitRate: C,
      isDefault: false,
    };
    const r = analyzeCapability(probe([video(), sub]), S({ container: 'mp4' }));
    const t = r.tracks.find((x) => x.streamIndex === 2);
    expect(t?.action).toBe('exclude');
    expect(t?.reason).toContain('제외');
    expect(r.limitations.some((l) => l.code === 'IMAGE_SUBTITLE_EXCLUDED')).toBe(true);
  });

  it('복사 모드에서 MP4 로 호환되지 않는 음성은 차단한다', () => {
    const r = analyzeCapability(
      probe([video(), audio(1, 'pcm_s16le')]),
      S({ mode: 'copy', container: 'mp4' }),
    );
    expect(r.support).toBe('blocked');
  });

  it('주 영상이 없으면 차단한다', () => {
    const r = analyzeCapability(probe([audio(0)]), S());
    expect(r.support).toBe('blocked');
  });

  it('길이를 모르면 목표 용량 모드는 차단된다', () => {
    const r = analyzeCapability(
      probe([video({ durationSec: C })], null),
      S({ mode: 'target', targetMiB: 100 }),
    );
    expect(r.support).toBe('blocked');
  });
});

describe('목표 용량 계산', () => {
  it('MiB 는 1,048,576 바이트로 환산한다', () => {
    expect(bytesPerMiB(1)).toBe(1_048_576);
  });

  it('음성 용량과 컨테이너 여유분을 뺀 나머지를 영상 비트레이트로 계산한다', () => {
    const p = probe([video({ bitRate: C }), audio(1, 'aac', { bitRate: conf(128_000) })], 100);
    const settings = S({ mode: 'target', targetMiB: 50 });
    const tracks = analyzeCapability(p, settings).tracks;
    const budget = computeTargetBudget(p, settings, p.streams[0]!, tracks);
    const totalBits = 50 * 1_048_576 * 8 * (1 - CONTAINER_OVERHEAD_RATIO);
    const expected = (totalBits - 128_000 * 100) / 100 / 1000;
    expect(budget.videoKbps).toBeCloseTo(expected, 6);
  });

  it('목표가 음성만으로도 부족하면 차단한다', () => {
    const p = probe([video(), audio(1, 'aac', { bitRate: conf(10_000_000) })], 100);
    const r = analyzeCapability(p, S({ mode: 'target', targetMiB: 10 }));
    expect(r.support).toBe('blocked');
  });
});

describe('인코딩 계획 (FFmpeg 인자)', () => {
  const opts = {
    inputPath: '/in/a b.mp4',
    outputPath: '/out/한글 결과.mp4',
    passLogPrefix: '/tmp/x/pass',
    nullSink: '/dev/null',
  };

  it('H.264 고품질 자동은 CRF 단일 패스이며 -n(덮어쓰기 금지)을 쓴다', () => {
    const p = probe([video(), audio(1)]);
    const s = S();
    const plan = buildEncodePlan(p, s, analyzeCapability(p, s), opts);
    expect(plan.passCount).toBe(1);
    const args = plan.passes[0]!;
    expect(args[0]).toBe('-n');
    expect(args).toContain('libx264');
    expect(args[args.indexOf('-crf') + 1]).toBe(String(BASE_CRF.h264));
    expect(args).toContain('-fps_mode');
    expect(args[args.length - 1]).toBe(opts.outputPath);
  });

  it('인자는 배열이므로 공백·한글 경로가 그대로 전달된다', () => {
    const p = probe([video()]);
    const plan = buildEncodePlan(p, S(), analyzeCapability(p, S()), opts);
    expect(plan.passes[0]).toContain(opts.inputPath);
  });

  it('H.265 와 H.264 의 CRF 기본값은 서로 다르다 (값 재사용 금지)', () => {
    expect(BASE_CRF.h264).not.toBe(BASE_CRF.hevc);
    expect(FAST_CRF.h264).not.toBe(FAST_CRF.hevc);
    expect(encoderFor(S({ codec: 'hevc' }))).toBe('libx265');
  });

  it('목표 용량은 2-pass 이고 1-pass 는 주 영상만 매핑하며 출력 결과를 남기지 않는다', () => {
    const p = probe([video(), audio(1)], 60);
    const s = S({ mode: 'target', targetMiB: 20 });
    const a = analyzeCapability(p, s);
    const plan = buildEncodePlan(p, s, a, opts);
    expect(plan.passCount).toBe(2);
    const pass1 = plan.passes[0]!;
    expect(pass1).toContain('-pass');
    expect(pass1[pass1.indexOf('-pass') + 1]).toBe('1');
    expect(pass1.filter((x) => x === '-map')).toHaveLength(1);
    expect(pass1[pass1.length - 1]).toBe('/dev/null');
    const pass2 = plan.passes[1]!;
    expect(pass2[pass2.indexOf('-pass') + 1]).toBe('2');
    expect(pass2[pass2.length - 1]).toBe(opts.outputPath);
  });

  it('복사 모드는 -c:v copy 이며 재인코더를 쓰지 않는다', () => {
    const p = probe([video(), audio(1)]);
    const s = S({ mode: 'copy', container: 'mkv' });
    const plan = buildEncodePlan(p, s, analyzeCapability(p, s), opts);
    expect(plan.encoder).toBe('copy');
    expect(plan.passes[0]).toContain('copy');
    expect(plan.passes[0]).not.toContain('libx264');
  });

  it('호환되지 않는 음성은 AAC 로 변환되고, 변환 사실이 notes 에 남는다', () => {
    const p = probe([video(), audio(1, 'opus')]);
    const s = S({ container: 'mp4' });
    const plan = buildEncodePlan(p, s, analyzeCapability(p, s), opts);
    expect(plan.passes[0]).toContain('aac');
    expect(plan.notes.some((n) => n.includes('AAC'))).toBe(true);
  });
});

export type { AnalysisResult };
