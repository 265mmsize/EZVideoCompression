/**
 * 하드웨어 인코더(GPU/QSV/AMF) 검사 (4단계).
 *
 * 설계 원칙
 * - GPU 모델 이름만으로 지원을 판단하지 않는다.
 * - 1) ffmpeg -encoders 에 인코더가 있는지 확인하고, 2) 실제로 짧은 테스트 인코딩을 해서 성공해야 사용 가능으로 본다.
 * - 실패하면 원인(마지막 오류 줄)을 기록해 화면에 보여주고, 빠른 압축은 CPU 인코더로 대체한다.
 * - 하드웨어 인코더의 품질 값(CQ·global_quality·QP)은 CRF 와 다른 척도이므로 별도의 표를 쓴다.
 *
 * 한계: 이 파일의 인자 조합은 NVENC·QSV·AMF 공식 옵션을 기준으로 작성했으나,
 * 실제 장치에서의 검증은 아직 수행하지 않았다 (테스트 환경에 GPU 가 없다). 화면에서도 "미검증"으로 표시한다.
 */
import type { HardwareEncoderStatus, VideoCodec } from '../../shared/types/domain';
import type { FFmpegProcessService } from './FFmpegProcessService';

type Family = HardwareEncoderStatus['family'];

const ENCODER_NAMES: Readonly<Record<Family, Readonly<Record<VideoCodec, string>>>> = {
  nvenc: { h264: 'h264_nvenc', hevc: 'hevc_nvenc' },
  qsv: { h264: 'h264_qsv', hevc: 'hevc_qsv' },
  amf: { h264: 'h264_amf', hevc: 'hevc_amf' },
};

/** 하드웨어 인코더별 품질 값 (CRF 와 다른 척도, 인코더마다 따로 둔다) */
export const HW_QUALITY: Readonly<Record<Family, Readonly<Record<VideoCodec, number>>>> = {
  nvenc: { h264: 26, hevc: 28 }, // -cq
  qsv: { h264: 24, hevc: 26 }, // -global_quality
  amf: { h264: 24, hevc: 26 }, // -qp_i / -qp_p
};

/** 검사 순서: 일반적으로 NVIDIA → Intel → AMD */
const FAMILY_ORDER: readonly Family[] = ['nvenc', 'qsv', 'amf'];
const TEST_TIMEOUT_MS = 20_000;

export function encoderNameOf(family: Family, codec: VideoCodec): string {
  return ENCODER_NAMES[family][codec];
}

/** ffmpeg -encoders 출력에서 존재하는 하드웨어 인코더 이름을 찾는다 */
export function listedHardwareEncoders(encodersOutput: string): HardwareEncoderStatus[] {
  const out: HardwareEncoderStatus[] = [];
  for (const family of FAMILY_ORDER) {
    for (const codec of ['h264', 'hevc'] as const) {
      const name = ENCODER_NAMES[family][codec];
      const listed = new RegExp(`\\b${name}\\b`).test(encodersOutput);
      out.push({
        name,
        family,
        codec,
        available: false,
        reason: listed ? null : '이 FFmpeg 빌드에 포함되어 있지 않습니다',
      });
    }
  }
  return out;
}

/** 테스트 인코딩 인자. 10프레임짜리 작은 입력으로 장치 초기화와 인코딩을 확인한다. */
export function testEncodeArgs(name: string): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=256x256:rate=30',
    '-frames:v',
    '10',
    '-c:v',
    name,
    '-f',
    'null',
    '-',
  ];
}

/** 빠른 압축에서 하드웨어 인코더 인자 (품질 값은 HW_QUALITY 표에서 가져온다) */
export function hardwareEncodeArgs(name: string, family: Family, codec: VideoCodec): string[] {
  const q = String(HW_QUALITY[family][codec]);
  switch (family) {
    case 'nvenc':
      return ['-c:v', name, '-preset', 'p4', '-rc', 'vbr', '-cq', q, '-b:v', '0'];
    case 'qsv':
      return ['-c:v', name, '-global_quality', q];
    case 'amf':
      return ['-c:v', name, '-rc', 'cqp', '-qp_i', q, '-qp_p', q];
  }
}

export function familyOf(name: string): Family | null {
  for (const f of FAMILY_ORDER) {
    if (ENCODER_NAMES[f].h264 === name || ENCODER_NAMES[f].hevc === name) return f;
  }
  return null;
}

/** 캐시: ffmpeg 경로와 인코더 이름 조합별 검사 결과 */
export class HardwareEncoderService {
  private readonly cache = new Map<string, { available: boolean; reason: string | null }>();

  constructor(private readonly proc: FFmpegProcessService) {}

  /** 전체 검사. ffmpeg -encoders 목록 확인 → 목록에 있는 인코더만 테스트 인코딩한다. */
  async probeAll(ffmpegPath: string): Promise<HardwareEncoderStatus[]> {
    const listing = await this.proc.run(ffmpegPath, ['-hide_banner', '-encoders'], {
      timeoutMs: 15_000,
      captureStdout: true,
    });
    const list = listedHardwareEncoders(listing.stdout);
    const result: HardwareEncoderStatus[] = [];
    for (const item of list) {
      if (item.reason !== null) {
        result.push(item);
        continue;
      }
      const verdict = await this.testOne(ffmpegPath, item.name);
      result.push({ ...item, ...verdict });
    }
    return result;
  }

  /** 주어진 코덱에서 사용할 수 있는 첫 하드웨어 인코더 이름. 없으면 null. */
  pick(
    statuses: readonly HardwareEncoderStatus[],
    codec: VideoCodec,
  ): HardwareEncoderStatus | null {
    return statuses.find((s) => s.codec === codec && s.available) ?? null;
  }

  private async testOne(
    ffmpegPath: string,
    name: string,
  ): Promise<{ available: boolean; reason: string | null }> {
    const key = `${ffmpegPath}|${name}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const res = await this.proc.run(ffmpegPath, testEncodeArgs(name), {
      timeoutMs: TEST_TIMEOUT_MS,
    });
    const verdict =
      res.exitCode === 0 && !res.timedOut
        ? { available: true, reason: null }
        : {
            available: false,
            reason: res.timedOut
              ? '테스트 인코딩 시간 초과'
              : (res.stderrTail.filter((l) => l.trim()).at(-1) ??
                `종료 코드 ${String(res.exitCode)}`),
          };
    this.cache.set(key, verdict);
    return verdict;
  }
}
