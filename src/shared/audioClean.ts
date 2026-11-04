/**
 * 소리 정리 필터 (순수 함수). 렌더 계획과 테스트가 같은 필터 문자열을 쓴다.
 * - 잡음 줄이기: FFmpeg 내장 afftdn (별도 모델 파일 없음)
 * - 보컬 줄이기: 좌우 차이만 남긴다. 가운데에 있는 목소리는 거의 지워지고 악기 소리는 남는다 (가라오케 방식)
 * - 가운데 남기기: 좌우를 합쳐 가운데 성분만 남긴다. 목소리가 가운데에 있을 때 잘 남는다.
 * 두 채널 연산은 스테레오 원본에서만 의미가 있다. 모노 원본에는 적용하지 않는다.
 */

export const NOISE_LEVELS = ['off', 'light', 'strong'] as const;
export type NoiseLevel = (typeof NOISE_LEVELS)[number];

export const VOCAL_MODES = ['off', 'reduce', 'isolate'] as const;
export type VocalMode = (typeof VOCAL_MODES)[number];

/** afftdn 의 잡음 감소량 (dB) */
export function noiseFilter(level: NoiseLevel): string | null {
  if (level === 'light') return 'afftdn=nr=12:nf=-30';
  if (level === 'strong') return 'afftdn=nr=24:nf=-30';
  return null;
}

/** 스테레오 채널 연산. 두 채널이 없으면 null. */
export function vocalFilter(mode: VocalMode, channels: number | null | undefined): string | null {
  if (channels === null || channels === undefined || channels < 2) return null;
  if (mode === 'reduce') return 'pan=stereo|c0=c0-c1|c1=c0-c1';
  if (mode === 'isolate') return 'pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1';
  return null;
}

export interface AudioCleanClip {
  noiseReduce?: NoiseLevel;
  vocal?: VocalMode;
  audioChannels?: number | null;
}

/** 클립에 적용할 소리 정리 필터들 (잡음 → 채널 연산 순서) */
export function audioCleanFilters(c: AudioCleanClip): string[] {
  const out: string[] = [];
  const v = vocalFilter(c.vocal ?? 'off', c.audioChannels);
  if (v) out.push(v);
  const n = noiseFilter(c.noiseReduce ?? 'off');
  if (n) out.push(n);
  return out;
}

/** 이 클립에서 보컬 옵션을 쓸 수 있는지 (사람이 읽는 이유 포함) */
export function vocalAvailability(channels: number | null | undefined): {
  ok: boolean;
  reason: string | null;
} {
  if (channels === null || channels === undefined)
    return { ok: false, reason: '음성 채널 정보를 알 수 없습니다' };
  if (channels < 2) return { ok: false, reason: '모노 소리라 좌우 채널을 나눌 수 없습니다' };
  return { ok: true, reason: null };
}
