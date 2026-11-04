/**
 * 오디오 파형 피크 계산 (순수 함수). FFmpeg 가 만든 모노 s16le PCM 을 초당 일정 개수의 피크(0~100)로 줄인다.
 */

/** 파형 추출에 쓰는 표본 주파수 (Hz). 피크만 보므로 낮아도 충분하다 */
export const WAVE_SAMPLE_RATE = 4000;
/** 초당 피크 개수 */
export const WAVE_PEAKS_PER_SEC = 50;
/** 이보다 긴 파일은 앞부분만 파형을 만든다 (초) */
export const WAVE_MAX_SEC = 3 * 3600;

export interface WaveformData {
  peaksPerSec: number;
  /** 0~100 정수. 각 칸의 최대 진폭 */
  peaks: number[];
}

/** s16le 모노 PCM → 피크 배열 */
export function computePeaks(pcm: Buffer, sampleRate: number, peaksPerSec: number): number[] {
  const samples = Math.floor(pcm.length / 2);
  const bucket = Math.max(1, Math.round(sampleRate / peaksPerSec));
  const out: number[] = [];
  for (let start = 0; start < samples; start += bucket) {
    const end = Math.min(samples, start + bucket);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(pcm.readInt16LE(i * 2));
      if (v > peak) peak = v;
    }
    out.push(Math.min(100, Math.round((peak / 32768) * 100)));
  }
  return out;
}
