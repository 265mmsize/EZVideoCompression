import { describe, expect, it } from 'vitest';
import {
  bitDepthFromPixFmt,
  parseProbeJson,
  parseRational,
  rotationOf,
  type RawStream,
} from '../../src/main/services/MediaProbeService';
import { parseClock, parseProgressBlock } from '../../src/main/services/FFmpegProcessService';
import { ProgressEstimator } from '../../src/main/services/ProgressEstimator';
import { parseFfmpegVersion, isSupportedVersion } from '../../src/main/services/FFmpegToolLocator';
import { maskPathsInText } from '../../src/main/platform/logger';

describe('ffprobe 값 파싱', () => {
  it('분수 프레임레이트를 해석하고 0/0 은 null 로 둔다', () => {
    expect(parseRational('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseRational('0/0')).toBeNull();
    expect(parseRational(undefined)).toBeNull();
  });

  it('비트 심도는 bits_per_raw_sample 을 우선하고 pix_fmt 에서 보조로 추정한다', () => {
    expect(bitDepthFromPixFmt('yuv420p10le', undefined)).toBe(10);
    expect(bitDepthFromPixFmt('yuv420p', '8')).toBe(8);
    expect(bitDepthFromPixFmt('yuv420p', undefined)).toBe(8);
  });

  it('회전 정보는 90 단위 값만 인정한다', () => {
    const s: RawStream = { index: 0, side_data_list: [{ rotation: -90 }] };
    expect(rotationOf(s)).toBe(270);
    expect(rotationOf({ index: 0, tags: { rotate: '45' } })).toBe(0);
  });

  it('길이·비트레이트가 없으면 추측하지 않고 unknown 으로 둔다', () => {
    const p = parseProbeJson(
      {
        streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 2, height: 2 }],
        format: {},
      },
      { path: '/a/b.mp4', sizeBytes: 1, mtimeMs: 1 },
    );
    expect(p.durationSec.source).toBe('unknown');
    expect(p.streams[0]!.bitRate.source).toBe('unknown');
  });

  it('스트림 길이가 없고 컨테이너 길이만 있으면 estimated 로 표시한다', () => {
    const p = parseProbeJson(
      {
        streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }],
        format: { duration: '12.5' },
      },
      { path: '/a/b.mp4', sizeBytes: 1, mtimeMs: 1 },
    );
    expect(p.streams[0]!.durationSec).toEqual({ value: 12.5, source: 'estimated' });
  });

  it('avg 와 r 프레임레이트 차이를 그 자체로 VFR 로 단정하지 않는다', () => {
    const p = parseProbeJson(
      {
        streams: [{ index: 0, codec_type: 'video', avg_frame_rate: '24/1', r_frame_rate: '30/1' }],
        format: {},
      },
      { path: '/a/b.mp4', sizeBytes: 1, mtimeMs: 1 },
    );
    expect(p.streams[0]!.avgFrameRate.value).toBe(24);
    expect(p.streams[0]!.nominalFrameRate.value).toBe(30);
    expect(JSON.stringify(p)).not.toMatch(/vfr/i);
  });
});

describe('ffmpeg 진행 출력 파싱', () => {
  it('-progress 블록에서 출력 시간과 속도를 읽는다', () => {
    const s = parseProgressBlock({
      out_time_us: '1500000',
      speed: '2.5x',
      frame: '45',
      progress: 'continue',
    });
    expect(s.outTimeSec).toBeCloseTo(1.5);
    expect(s.speed).toBe(2.5);
  });

  it('N/A 값은 null 이다', () => {
    const s = parseProgressBlock({ out_time_us: 'N/A', speed: 'N/A' });
    expect(s.outTimeSec).toBeNull();
    expect(s.speed).toBeNull();
  });

  it('HH:MM:SS 시계 문자열을 초로 바꾼다', () => {
    expect(parseClock('00:01:02.500')).toBeCloseTo(62.5);
    expect(parseClock('bad')).toBeNull();
  });
});

describe('진행률·남은 시간 추정', () => {
  it('길이를 모르면 진행률은 null (불확정)', () => {
    const e = new ProgressEstimator(null, 0);
    expect(e.update(5, 1, 10_000).ratio).toBeNull();
  });

  it('워밍업 전에는 ETA 를 내지 않는다', () => {
    const e = new ProgressEstimator(100, 0);
    const snap = e.update(0.5, 2, 1000);
    expect(snap.etaSec).toBeNull();
    expect(snap.ratio).toBeCloseTo(0.005);
  });

  it('2-pass 에서 두 번째 패스는 전체의 뒤쪽 절반으로 계산된다', () => {
    const e = new ProgressEstimator(100, 0);
    const snap = e.update(50, 1, 10_000, { index: 1, count: 2 });
    expect(snap.ratio).toBeCloseTo(0.75);
  });
});

describe('버전·로그 마스킹', () => {
  it('ffmpeg 버전 줄을 파싱하고 5.1 미만을 거부한다', () => {
    const v = parseFfmpegVersion('ffmpeg version 6.1.1-3ubuntu5 Copyright');
    expect(v).toEqual({ major: 6, minor: 1, raw: 'ffmpeg version 6.1.1-3ubuntu5 Copyright' });
    expect(isSupportedVersion({ major: 5, minor: 0 })).toBe(false);
    expect(isSupportedVersion({ major: 5, minor: 1 })).toBe(true);
  });

  it('Windows·POSIX 경로를 가린다', () => {
    const masked = maskPathsInText('path=C:\\Users\\me\\영상\\a.mp4 and /home/user/x/b.mkv end');
    expect(masked).not.toContain('Users');
    expect(masked).not.toContain('/home/user');
    expect(masked).toContain('<path>');
  });
});
