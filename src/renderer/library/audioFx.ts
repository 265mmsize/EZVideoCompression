/**
 * 재생 음향·화면 효과의 순수 계산: 이퀄라이저 대역과 프리셋, 화면 효과의 CSS 필터, 저장된 설정 검증.
 * 실제 소리 처리는 audioGraph.ts 가 맡는다.
 */

/** 이퀄라이저 중심 주파수 (Hz, 10밴드) */
export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_BANDS = EQ_FREQS.length;
/** 한 밴드의 최대 증폭·감쇠 (dB) */
export const EQ_LIMIT_DB = 12;
/** 밴드 조절 단위 (dB) */
export const EQ_STEP_DB = 0.5;

const FLAT = EQ_FREQS.map(() => 0);

export const EQ_PRESETS: Readonly<Record<string, readonly number[]>> = {
  평탄: FLAT,
  저음강조: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  고음강조: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6],
  목소리: [-3, -2, 0, 2, 4, 4, 3, 1, 0, -1],
  록: [4, 3, 1, -1, -2, 0, 2, 3, 4, 4],
  팝: [-1, 1, 3, 4, 3, 0, -1, -1, -1, -1],
  영화: [3, 2, 0, -1, 0, 1, 2, 2, 1, 0],
};

/** 한 밴드 값을 허용 범위와 조절 단위에 맞춘다 */
export function clampGain(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const c = Math.min(EQ_LIMIT_DB, Math.max(-EQ_LIMIT_DB, v));
  return Math.round(c / EQ_STEP_DB) * EQ_STEP_DB;
}

/** 저장된 이퀄라이저 값을 검증한다. 모양이 맞지 않으면 평탄으로 돌아간다. */
export function sanitizeEq(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length !== EQ_BANDS) return [...FLAT];
  return raw.map((v) => clampGain(typeof v === 'number' ? v : 0));
}

/** 화면 효과 이름 */
export const FX_NAMES = [
  'none',
  'grayscale',
  'sepia',
  'invert',
  'vintage',
  'cool',
  'warm',
  'soft',
  'contrast',
] as const;
export type FxName = (typeof FX_NAMES)[number];

export const FX_LABELS: Readonly<Record<FxName, string>> = {
  none: '없음',
  grayscale: '흑백',
  sepia: '세피아',
  invert: '반전',
  vintage: '빈티지',
  cool: '시원하게',
  warm: '따뜻하게',
  soft: '부드럽게',
  contrast: '선명한 대비',
};

/** 화면 효과를 CSS 필터 문자열로 바꾼다 */
export function fxFilter(name: FxName): string {
  switch (name) {
    case 'grayscale':
      return 'grayscale(1)';
    case 'sepia':
      return 'sepia(0.9)';
    case 'invert':
      return 'invert(1)';
    case 'vintage':
      return 'sepia(0.5) contrast(1.1) brightness(0.95) saturate(0.8)';
    case 'cool':
      return 'hue-rotate(-15deg) saturate(1.1)';
    case 'warm':
      return 'sepia(0.25) saturate(1.2)';
    case 'soft':
      return 'blur(1.2px) brightness(1.05)';
    case 'contrast':
      return 'contrast(1.4) saturate(1.2)';
    default:
      return 'none';
  }
}

export interface FxSettings {
  preset: FxName;
  /** 가장자리를 어둡게 (비네팅) */
  vignette: boolean;
  /** 가로 줄무늬 (스캔라인) */
  scanlines: boolean;
}

export const FX_DEFAULT: FxSettings = { preset: 'none', vignette: false, scanlines: false };

export function sanitizeFx(raw: unknown): FxSettings {
  if (!raw || typeof raw !== 'object') return { ...FX_DEFAULT };
  const r = raw as Partial<Record<keyof FxSettings, unknown>>;
  const preset = (FX_NAMES as readonly string[]).includes(String(r.preset))
    ? (r.preset as FxName)
    : 'none';
  return {
    preset,
    vignette: r.vignette === true,
    scanlines: r.scanlines === true,
  };
}

/** 밴드 하나의 필터 매개변수 (피킹 필터, Q 는 밴드 사이가 자연스럽게 이어지는 값) */
export function bandParams(
  freq: number,
  gainDb: number,
): { type: 'peaking'; frequency: number; gain: number; Q: number } {
  return { type: 'peaking', frequency: freq, gain: clampGain(gainDb), Q: 1.1 };
}

/** 이퀄라이저·화면 효과 설정의 저장 키 (이 PC에만 저장한다) */
export const EQ_STORAGE_KEY = 'vslim.eq';
export const FX_STORAGE_KEY = 'vslim.fx';
