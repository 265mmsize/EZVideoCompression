import { describe, expect, it } from 'vitest';
import {
  hardwareEncodeArgs,
  HW_QUALITY,
  listedHardwareEncoders,
  testEncodeArgs,
  familyOf,
} from '../../src/main/services/HardwareEncoderService';
import { buildEncodePlan, FAST_CRF } from '../../src/main/services/CompressionPolicyService';
import { analyzeCapability } from '../../src/main/services/CapabilityService';
import type { JobSettings, ProbeResult, ProbeStream } from '../../src/shared/types/domain';

const LISTING = ` V....D libx264  libx264 H.264
 V....D h264_nvenc  NVIDIA NVENC H.264 encoder
 V..... hevc_qsv  HEVC QSV
`;

describe('하드웨어 인코더 목록 확인', () => {
  it('목록에 없는 인코더는 사유와 함께 사용 불가로 둔다', () => {
    const list = listedHardwareEncoders(LISTING);
    const nv = list.find((x) => x.name === 'h264_nvenc');
    expect(nv?.reason).toBeNull(); // 목록에는 있음 → 테스트 인코딩 대상
    const amf = list.find((x) => x.name === 'h264_amf');
    expect(amf?.reason).toContain('포함되어 있지 않습니다');
    expect(amf?.available).toBe(false);
  });

  it('인코더 이름으로 계열을 찾는다', () => {
    expect(familyOf('hevc_qsv')).toBe('qsv');
    expect(familyOf('libx264')).toBeNull();
  });

  it('테스트 인코딩은 짧은 입력과 null 출력을 쓴다', () => {
    const a = testEncodeArgs('h264_nvenc');
    expect(a).toContain('-frames:v');
    expect(a[a.length - 1]).toBe('-');
  });
});

describe('하드웨어 인코더 인자와 품질 값', () => {
  it('계열별 품질 옵션을 쓰며 CRF 값을 재사용하지 않는다', () => {
    expect(hardwareEncodeArgs('h264_nvenc', 'nvenc', 'h264')).toEqual(
      expect.arrayContaining(['-rc', 'vbr', '-cq', String(HW_QUALITY.nvenc.h264)]),
    );
    expect(hardwareEncodeArgs('hevc_qsv', 'qsv', 'hevc')).toEqual([
      '-c:v',
      'hevc_qsv',
      '-global_quality',
      String(HW_QUALITY.qsv.hevc),
    ]);
    expect(hardwareEncodeArgs('h264_amf', 'amf', 'h264')).toContain('-qp_i');
    expect(hardwareEncodeArgs('h264_nvenc', 'nvenc', 'h264')).not.toContain('-crf');
    expect(HW_QUALITY.nvenc.h264).not.toBe(FAST_CRF.h264);
  });
});

describe('인코딩 계획의 하드웨어 분기', () => {
  const stream: ProbeStream = {
    index: 0,
    kind: 'video',
    codecName: 'h264',
    codecLongName: null,
    language: null,
    title: null,
    isDefault: true,
    isAttachedPic: false,
    width: 640,
    height: 360,
    pixFmt: 'yuv420p',
    bitDepth: 8,
    hasAlpha: false,
    fieldOrder: 'progressive',
    avgFrameRate: { value: 30, source: 'confirmed' },
    nominalFrameRate: { value: 30, source: 'confirmed' },
    rotation: 0,
    colorSpace: null,
    colorRange: null,
    colorTransfer: null,
    colorPrimaries: null,
    hasDolbyVision: false,
    bitRate: { value: null, source: 'unknown' },
    channels: null,
    channelLayout: null,
    sampleRate: null,
    durationSec: { value: 10, source: 'confirmed' },
    startTimeSec: 0,
    timeBase: null,
    disposition: {},
  };
  const probe: ProbeResult = {
    path: '/a.mp4',
    fileName: 'a.mp4',
    sizeBytes: 1,
    mtimeMs: 1,
    formatName: 'mp4',
    durationSec: { value: 10, source: 'confirmed' },
    bitRate: { value: null, source: 'unknown' },
    streams: [stream],
    chapters: [],
  };
  const settings: JobSettings = {
    mode: 'fast',
    preset: 'speed',
    container: 'mp4',
    codec: 'h264',
    targetMiB: null,
    videoStreamIndex: null,
    crf: null,
    externalSubtitles: true,
  };
  const opts = {
    inputPath: '/a.mp4',
    outputPath: '/o.mp4',
    passLogPrefix: '/t/p',
    nullSink: '/dev/null',
  };

  it('하드웨어 인코더가 있으면 빠른 압축에 그 인코더를 쓰고 CRF 는 쓰지 않는다', () => {
    const plan = buildEncodePlan(probe, settings, analyzeCapability(probe, settings), {
      ...opts,
      hardwareEncoder: { name: 'h264_nvenc', family: 'nvenc' },
    });
    expect(plan.encoder).toBe('h264_nvenc');
    expect(plan.passes[0]).toContain('h264_nvenc');
    expect(plan.passes[0]).not.toContain('-crf');
  });

  it('하드웨어 인코더가 없으면 CPU 인코더를 쓴다', () => {
    const plan = buildEncodePlan(probe, settings, analyzeCapability(probe, settings), {
      ...opts,
      hardwareEncoder: null,
    });
    expect(plan.encoder).toBe('libx264');
    expect(plan.passes[0]).toContain('-crf');
  });
});

describe('하드웨어 픽셀 포맷', () => {
  it('10비트는 p010le 로, 8비트는 그대로 둔다 (비트 심도 유지)', async () => {
    const { hardwarePixFmt } = await import('../../src/main/services/CompressionPolicyService');
    expect(hardwarePixFmt('yuv420p10le')).toBe('p010le');
    expect(hardwarePixFmt('yuv420p')).toBe('yuv420p');
  });
});
