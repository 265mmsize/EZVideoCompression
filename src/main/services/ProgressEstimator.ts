/**
 * 진행률과 남은 시간 추정.
 *
 * - 진행률은 출력 미디어 시간 / 입력 길이 로 계산한다. 길이를 모르면 null (불확정 상태).
 * - 속도는 지수 이동 평균으로 완화한다. 초기 몇 초의 급격한 변동이 ETA 를 흔들지 않게 한다.
 * - 시작 직후(경과 5초 미만이고 진행률 2% 미만)에는 ETA 를 내지 않는다.
 * - ETA 는 추정치다. 화면에서도 "약"과 "추정"으로 표시한다.
 */
export interface EstimateSnapshot {
  ratio: number | null;
  speed: number | null;
  etaSec: number | null;
  outTimeSec: number | null;
}

export class ProgressEstimator {
  private emaSpeed: number | null = null;
  private readonly startedAt: number;
  private readonly alpha: number;

  constructor(
    private readonly durationSec: number | null,
    startedAtMs: number,
    alpha = 0.3,
  ) {
    this.startedAt = startedAtMs;
    this.alpha = alpha;
  }

  /**
   * @param outTimeSec 현재까지 처리된 미디어 시간
   * @param speed FFmpeg 가 보고한 실시간 대비 배수
   * @param nowMs 현재 시각 (테스트를 위해 주입)
   * @param passFraction 2-pass 등에서 이 패스가 전체에서 차지하는 구간 시작·길이 (기본: 전체)
   */
  update(
    outTimeSec: number | null,
    speed: number | null,
    nowMs: number,
    passFraction: { index: number; count: number } = { index: 0, count: 1 },
  ): EstimateSnapshot {
    if (speed !== null && speed > 0) {
      this.emaSpeed =
        this.emaSpeed === null ? speed : this.alpha * speed + (1 - this.alpha) * this.emaSpeed;
    }
    let passRatio: number | null = null;
    if (outTimeSec !== null && this.durationSec !== null && this.durationSec > 0) {
      passRatio = Math.min(1, Math.max(0, outTimeSec / this.durationSec));
    }
    const ratio = passRatio === null ? null : (passFraction.index + passRatio) / passFraction.count;

    const elapsedSec = (nowMs - this.startedAt) / 1000;
    let etaSec: number | null = null;
    const warmedUp = elapsedSec >= 5 || (ratio !== null && ratio >= 0.02);
    if (
      warmedUp &&
      ratio !== null &&
      this.emaSpeed !== null &&
      this.emaSpeed > 0 &&
      this.durationSec !== null
    ) {
      const remainingMediaSec = this.durationSec * (1 - ratio);
      etaSec = Math.max(0, remainingMediaSec / this.emaSpeed);
    }
    return {
      ratio,
      speed: this.emaSpeed,
      etaSec,
      outTimeSec,
    };
  }
}

/** 0~1 사이의 진행률을 화면 표시용 퍼센트 문자열로 바꾼다. 불확정이면 null. */
export function formatPercent(ratio: number | null): string | null {
  if (ratio === null) return null;
  return `${String(Math.floor(ratio * 100))}%`;
}
