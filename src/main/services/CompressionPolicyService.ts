/**
 * FFmpeg 인코딩 계획(인자 배열) 생성.
 *
 * 설계 이유
 * - 인코더마다 CRF 의 의미가 다르므로 H.264 와 H.265 의 기본값을 따로 둔다 (값을 그대로 재사용하지 않는다).
 * - 프레임 타이밍 보존을 위해 -fps_mode passthrough 를 사용한다 (가변 프레임률 영상의 타임스탬프 유지).
 * - 자동 크롭·노이즈 제거·색상 변경은 넣지 않는다. 필요한 변환은 CapabilityService 가 사유와 함께 표시한 것뿐이다.
 * - 목표 용량은 2-pass 로 처리한다. 현재 지원 인코더(libx264, libx265)는 모두 -pass 를 지원한다.
 *   하드웨어 인코더는 2-pass 를 가정하지 않으며, 4단계에서 인코더별 검사 후에만 허용한다.
 *
 * 이 모듈은 인자 배열만 만들고 실행하지 않는다. 실행은 FFmpegProcessService 가 맡는다.
 */
import path from 'node:path';
import { hardwareEncodeArgs } from './HardwareEncoderService';
import type {
  AnalysisResult,
  ExternalSubtitleDecision,
  JobSettings,
  Preset,
  ProbeResult,
  TrackDecision,
  VideoCodec,
} from '../../shared/types/domain';

export type EncoderName = string;

/**
 * 인코더별 기본 CRF. 서로 다른 인코더의 값을 재사용하지 않는다.
 * 이 값은 "제품 초기값"이며, 3단계 샘플 인코딩 추천으로 조정된다.
 */
export const BASE_CRF: Readonly<Record<VideoCodec, number>> = {
  h264: 21,
  hevc: 25,
};

/** 빠른 압축(fast) 모드의 CRF. 속도 우선이므로 약간 높게 둔다. */
export const FAST_CRF: Readonly<Record<VideoCodec, number>> = {
  h264: 23,
  hevc: 28,
};

interface PresetSpec {
  x264: string;
  x265: string;
  /** 저장 공간 우선일수록 양수(= 파일이 작아짐). 목표 용량 모드에서는 쓰지 않는다. */
  crfOffset: number;
}

export const PRESET_SPECS: Readonly<Record<Preset, PresetSpec>> = {
  compatibility: { x264: 'medium', x265: 'medium', crfOffset: 0 },
  space: { x264: 'slow', x265: 'slow', crfOffset: 3 },
  speed: { x264: 'veryfast', x265: 'veryfast', crfOffset: 2 },
};

/** 모드·프리셋·코덱으로 정해지는 기본 CRF. 사용자가 CRF 를 지정했으면 그 값이 우선한다. */
export function defaultCrfFor(settings: JobSettings): number {
  if (settings.crf !== null) return settings.crf;
  if (settings.mode === 'fast') return FAST_CRF[settings.codec];
  return BASE_CRF[settings.codec] + PRESET_SPECS[settings.preset].crfOffset;
}

export const AUDIO_TRANSCODE_KBPS_STEREO = 128;
export const AUDIO_TRANSCODE_KBPS_MULTI = 384;

export interface EncodePlanOptions {
  /** 빠른 압축에서 쓸 하드웨어 인코더. null 이면 CPU 인코더를 쓴다. */
  hardwareEncoder?: { name: string; family: 'nvenc' | 'qsv' | 'amf' } | null;
  inputPath: string;
  outputPath: string;
  /** 2-pass 로그 접두사 (작업 전용 임시 디렉터리 안) */
  passLogPrefix: string;
  /** 목표 용량 모드에서 재시도 시 바뀌는 영상 비트레이트 (kbps). 없으면 analysis 값 사용 */
  videoKbpsOverride?: number | null;
  /** 1-pass 에서 -f null 로 버릴 출력 장치 (플랫폼별) */
  nullSink: string;
  /** 설정 미리보기용 입력 구간. 입력 옵션(-ss/-t)으로 넣어 해당 구간만 읽는다. */
  inputTrim?: { startSec: number; durationSec: number } | null;
  /**
   * 결과에 합칠 외부 자막 (UTF-8 임시 복사본 경로와 결정). 입력 1, 2, … 로 추가된다.
   * 설정 미리보기와 샘플 인코딩에서는 넘기지 않는다.
   */
  externalSubtitles?: readonly { inputPath: string; decision: ExternalSubtitleDecision }[];
}

export interface EncodePlan {
  encoder: EncoderName;
  encoderLabel: string;
  /** 필요한 패스 수. copy 는 1, 2-pass 목표 용량은 2 */
  passCount: number;
  /** 각 패스의 FFmpeg 인자 배열 (실행 파일 이름 제외). 마지막 요소는 출력 경로다. */
  passes: string[][];
  /** 인코딩 중 사용한 비트레이트 (목표 용량일 때만) */
  videoKbps: number | null;
  /** 작업 종료 후 정리해야 하는 2-pass 로그 접두사 */
  passLogPrefix: string;
  /** 사용자에게 보여줄 처리 요약 (트랙 변환 사실 등) */
  notes: string[];
}

export function encoderFor(settings: JobSettings): EncoderName {
  if (settings.mode === 'copy') return 'copy';
  return settings.codec === 'h264' ? 'libx264' : 'libx265';
}

export function encoderLabel(enc: EncoderName): string {
  switch (enc) {
    case 'libx264':
      return 'libx264 (CPU, 소프트웨어)';
    case 'libx265':
      return 'libx265 (CPU, 소프트웨어)';
    case 'copy':
      return '스트림 복사 (재인코딩 없음)';
    default:
      return enc;
  }
}

/** 출력 픽셀 포맷. 10비트 원본을 8비트로 조용히 바꾸지 않는다 (H.264 10비트는 차단 단계에서 걸린다). */
export function outputPixFmt(
  probe: ProbeResult,
  primaryIndex: number | null,
  codec: VideoCodec,
): string {
  const primary = probe.streams.find((s) => s.index === primaryIndex);
  const bits = primary?.bitDepth ?? 8;
  if (codec === 'hevc' && bits > 8) return 'yuv420p10le';
  return 'yuv420p';
}

/**
 * 하드웨어 인코더용 픽셀 포맷. NVENC·QSV·AMF 는 10비트 입력을 평면 yuv420p10le 가 아니라 p010le 로 받는다.
 * 비트 심도는 그대로 유지한다 (8비트 → yuv420p, 10비트 → p010le).
 */
export function hardwarePixFmt(softwarePixFmt: string): string {
  return softwarePixFmt === 'yuv420p10le' ? 'p010le' : softwarePixFmt;
}

export function buildEncodePlan(
  probe: ProbeResult,
  settings: JobSettings,
  analysis: AnalysisResult,
  opts: EncodePlanOptions,
): EncodePlan {
  if (analysis.primaryVideoIndex === null) {
    throw new Error('주 영상 트랙이 없어 인코딩 계획을 만들 수 없습니다');
  }
  const enc = encoderFor(settings);
  const externals = (opts.externalSubtitles ?? []).filter((e) => e.decision.action !== 'exclude');
  const notes = [
    ...summarizeNotes(analysis.tracks),
    ...externals.map((e) => `외부 자막 ${e.decision.fileName}: ${e.decision.reason}`),
  ];
  const kept = analysis.tracks.filter((t) => t.action !== 'exclude');

  const common = (): string[] => {
    const args: string[] = [
      '-n', // 기존 파일을 절대 덮어쓰지 않는다 (임시 경로는 항상 새 이름)
      '-hide_banner',
      '-loglevel',
      'warning',
      '-nostats',
      '-progress',
      'pipe:1',
    ];
    if (opts.inputTrim) {
      args.push(
        '-ss',
        opts.inputTrim.startSec.toFixed(3),
        '-t',
        opts.inputTrim.durationSec.toFixed(3),
      );
    }
    args.push('-i', opts.inputPath);
    // 외부 자막은 입력 1, 2, … 로 붙인다. 입력 구간(-ss/-t)은 영상 입력에만 적용된다.
    for (const e of externals) args.push('-i', e.inputPath);
    // 주 영상 + 유지되는 음성·자막·첨부 트랙만 명시적으로 매핑한다. 나머지는 위 분석에서 사유와 함께 제외된 것이다.
    for (const t of kept) args.push('-map', `0:${String(t.streamIndex)}`);
    externals.forEach((_, i) => args.push('-map', `${String(i + 1)}:0`));
    args.push('-map_chapters', '0');
    return args;
  };

  const trackArgs = (): string[] =>
    trackCodecArgs(
      kept,
      settings.container,
      probe,
      externals.map((e) => e.decision),
    );
  const outputArgs = (): string[] => {
    const out = [...trackArgs()];
    if (settings.container === 'mp4') out.push('-movflags', '+faststart');
    return out;
  };

  if (enc === 'copy') {
    const args = [...common(), '-c:v', 'copy', ...outputArgs(), opts.outputPath];
    return {
      encoder: 'copy',
      encoderLabel: encoderLabel('copy'),
      passCount: 1,
      passes: [args],
      videoKbps: null,
      passLogPrefix: opts.passLogPrefix,
      notes,
    };
  }

  const pixFmt = outputPixFmt(probe, analysis.primaryVideoIndex, settings.codec);
  const tagArgs =
    settings.container === 'mp4' && settings.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [];
  const preset = PRESET_SPECS[settings.preset];
  const x265Name = enc === 'libx265' ? 'libx265' : 'libx264';
  const presetName = enc === 'libx265' ? preset.x265 : preset.x264;
  // 빠른 압축은 두 인코더 모두 가장 빠른 계열 프리셋을 쓴다.
  const fastPreset = 'veryfast';

  // 목표 용량: 2-pass
  if (settings.mode === 'target') {
    const kbps = Math.max(1, Math.floor(opts.videoKbpsOverride ?? analysis.targetVideoKbps ?? 0));
    if (!kbps) throw new Error('목표 용량 비트레이트를 계산할 수 없습니다');
    const rate = ['-b:v', `${String(kbps)}k`];
    // 1-pass 는 결과를 버리므로 주 영상만 디코딩·인코딩한다 (음성·자막은 -an/-sn 으로 제외).
    const pass1 = [
      ...common(),
      '-c:v',
      x265Name,
      '-preset',
      presetName,
      ...rate,
      '-pix_fmt',
      pixFmt,
      '-fps_mode',
      'passthrough',
      '-pass',
      '1',
      '-passlogfile',
      opts.passLogPrefix,
      '-an',
      '-sn',
      '-dn',
      '-f',
      'null',
      opts.nullSink,
    ];
    const pass1Args = pass1WithVideoOnly(pass1, analysis.primaryVideoIndex);
    const pass2 = [
      ...common(),
      '-c:v',
      x265Name,
      '-preset',
      presetName,
      ...rate,
      '-pix_fmt',
      pixFmt,
      '-fps_mode',
      'passthrough',
      '-pass',
      '2',
      '-passlogfile',
      opts.passLogPrefix,
      ...tagArgs,
      ...outputArgs(),
      opts.outputPath,
    ];
    return {
      encoder: enc,
      encoderLabel: encoderLabel(enc),
      passCount: 2,
      passes: [pass1Args, pass2],
      videoKbps: kbps,
      passLogPrefix: opts.passLogPrefix,
      notes,
    };
  }

  // 고품질 자동 / 빠른 압축: CRF 단일 패스
  // 빠른 압축 + 하드웨어 인코더: 품질 값은 하드웨어 전용 표를 쓴다 (CRF 값을 재사용하지 않는다)
  if (settings.mode === 'fast' && opts.hardwareEncoder) {
    const hw = opts.hardwareEncoder;
    const args = [
      ...common(),
      ...hardwareEncodeArgs(hw.name, hw.family, settings.codec),
      '-pix_fmt',
      hardwarePixFmt(pixFmt),
      '-fps_mode',
      'passthrough',
      ...tagArgs,
      ...outputArgs(),
      opts.outputPath,
    ];
    return {
      encoder: hw.name,
      encoderLabel: `${hw.name} (하드웨어 가속, 미검증 장치에서는 CPU 로 대체 가능)`,
      passCount: 1,
      passes: [args],
      videoKbps: null,
      passLogPrefix: opts.passLogPrefix,
      notes,
    };
  }

  const crf = defaultCrfFor(settings);
  const speed = settings.mode === 'fast' ? fastPreset : presetName;
  const args = [
    ...common(),
    '-c:v',
    x265Name,
    '-preset',
    speed,
    '-crf',
    String(crf),
    '-pix_fmt',
    pixFmt,
    '-fps_mode',
    'passthrough',
    ...tagArgs,
    ...outputArgs(),
    opts.outputPath,
  ];
  return {
    encoder: enc,
    encoderLabel: encoderLabel(enc),
    passCount: 1,
    passes: [args],
    videoKbps: null,
    passLogPrefix: opts.passLogPrefix,
    notes,
  };
}

/** 1-pass 에서 음성·자막 매핑을 제거하고 주 영상만 디코딩하도록 -map 을 재작성한다. */
function pass1WithVideoOnly(args: string[], primaryIndex: number | null): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const cur = args[i] ?? '';
    const next = args[i + 1];
    if (cur === '-map' && next !== undefined) {
      if (next === `0:${String(primaryIndex)}`) out.push('-map', next);
      i++;
      continue;
    }
    out.push(cur);
  }
  return out;
}

/**
 * 트랙별 코덱 인자. `:N` 은 출력 스트림 안에서의 종류별 순서(0부터)다.
 * 음성 변환은 채널 수에 따라 비트레이트를 고르고, 채널 수 자체는 원본을 유지한다.
 */
export function trackCodecArgs(
  kept: readonly TrackDecision[],
  container: JobSettings['container'],
  probe: ProbeResult,
  externalSubtitles: readonly ExternalSubtitleDecision[] = [],
): string[] {
  const args: string[] = [];
  const ordinal: Record<'audio' | 'subtitle', number> = { audio: 0, subtitle: 0 };
  for (const t of kept) {
    if (t.kind === 'audio') {
      const n = ordinal.audio++;
      if (t.action === 'copy') args.push(`-c:a:${String(n)}`, 'copy');
      else {
        const channels = probe.streams.find((s) => s.index === t.streamIndex)?.channels ?? 2;
        const kbps = channels <= 2 ? AUDIO_TRANSCODE_KBPS_STEREO : AUDIO_TRANSCODE_KBPS_MULTI;
        args.push(`-c:a:${String(n)}`, 'aac', `-b:a:${String(n)}`, `${String(kbps)}k`);
      }
    } else if (t.kind === 'subtitle') {
      const n = ordinal.subtitle++;
      if (t.action === 'transcode') {
        args.push(`-c:s:${String(n)}`, container === 'mp4' ? 'mov_text' : 'srt');
      } else if (t.action === 'copy') {
        args.push(`-c:s:${String(n)}`, 'copy');
      }
    }
  }
  // 외부 자막은 내장 자막 뒤에 매핑되므로 종류별 순서도 그 뒤를 잇는다.
  for (const d of externalSubtitles) {
    if (d.action === 'exclude') continue;
    const n = ordinal.subtitle++;
    args.push(
      `-c:s:${String(n)}`,
      d.action === 'copy' ? 'copy' : container === 'mp4' ? 'mov_text' : 'srt',
    );
    if (d.language) args.push(`-metadata:s:s:${String(n)}`, `language=${d.language}`);
    args.push(`-metadata:s:s:${String(n)}`, `title=${d.fileName}`);
  }
  return args;
}

export function summarizeNotes(tracks: readonly TrackDecision[]): string[] {
  return tracks
    .filter((t) => t.action !== 'copy' && t.action !== 'encode' && t.action !== 'keep')
    .map((t) => `${t.label}: ${t.reason}`);
}

/** 2-pass 임시 로그 경로 접두사를 만든다. 디렉터리는 작업 전용이며 종료 후 통째로 삭제한다. */
export function passLogPrefixIn(jobTempDir: string): string {
  return path.join(jobTempDir, 'pass');
}
