/**
 * 도메인 타입 정의.
 *
 * 메인 프로세스(정책·서비스)와 렌더러(화면)가 같은 타입을 공유한다.
 * 이 파일은 Electron 이나 Node 전용 API 에 의존하지 않는다.
 */

// ---------------------------------------------------------------------------
// 작업 상태 및 허용 전이
// ---------------------------------------------------------------------------

export const JOB_STATUSES = [
  'queued',
  'probing',
  'analyzing',
  'ready',
  'encoding',
  'validating',
  'completed',
  'no_savings',
  'failed',
  'cancelling',
  'cancelled',
  'interrupted',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * 허용된 상태 전이표. 여기에 없는 전이는 모두 거부된다.
 *
 * - ready  : 분석이 끝나 사용자의 "시작"을 기다리는 상태
 * - queued : 사용자가 시작을 눌러 단일 인코딩 슬롯을 기다리는 상태
 * - interrupted : 앱 종료·비정상 종료로 중단된 작업 (재실행 시 감지)
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  probing: ['analyzing', 'failed', 'interrupted'],
  analyzing: ['ready', 'failed', 'interrupted'],
  ready: ['queued', 'probing'],
  queued: ['encoding', 'ready', 'interrupted'],
  encoding: ['validating', 'cancelling', 'failed', 'interrupted'],
  validating: ['completed', 'no_savings', 'cancelling', 'failed', 'interrupted'],
  cancelling: ['cancelled', 'failed'],
  cancelled: ['probing'],
  failed: ['probing'],
  interrupted: ['probing'],
  completed: ['probing'],
  no_savings: ['probing'],
};

/** 사용자가 목록에서 삭제할 수 있는 상태 (실행 중이거나 전환 중인 작업은 제외) */
export const DELETABLE_STATUSES: readonly JobStatus[] = [
  'ready',
  'queued',
  'completed',
  'no_savings',
  'failed',
  'cancelled',
  'interrupted',
];

/** 진행 중(슬롯을 점유하거나 점유 예정)인 상태. 중복 등록 검사에 사용한다. */
export const ACTIVE_STATUSES: readonly JobStatus[] = [
  'queued',
  'probing',
  'analyzing',
  'ready',
  'encoding',
  'validating',
  'cancelling',
];

// ---------------------------------------------------------------------------
// 압축 설정
// ---------------------------------------------------------------------------

/**
 * 압축 모드.
 * - copy    : 원본 유지 (영상 스트림을 재인코딩하지 않음)
 * - quality : 고품질 자동 (CRF 기반, 원본 해상도 유지) — 기본값
 * - fast    : 빠른 압축 (현재는 CPU 빠른 프리셋, GPU 가속은 4단계 예정)
 * - target  : 목표 용량 (MiB 단위, 2-pass 사용)
 */
export const COMPRESSION_MODES = ['copy', 'quality', 'fast', 'target'] as const;
export type CompressionMode = (typeof COMPRESSION_MODES)[number];

/** 프리셋: 인코더 속도와 CRF 보정값을 정한다. 코덱·컨테이너는 별도 설정이다. */
export const PRESETS = ['compatibility', 'space', 'speed'] as const;
export type Preset = (typeof PRESETS)[number];

export const OUTPUT_CONTAINERS = ['mp4', 'mkv'] as const;
export type OutputContainer = (typeof OUTPUT_CONTAINERS)[number];

export const VIDEO_CODECS = ['h264', 'hevc'] as const;
export type VideoCodec = (typeof VIDEO_CODECS)[number];

export interface JobSettings {
  mode: CompressionMode;
  preset: Preset;
  container: OutputContainer;
  codec: VideoCodec;
  /** 목표 용량 (MiB = 1,048,576 바이트). mode 가 target 일 때만 사용 */
  targetMiB: number | null;
  /** 주 영상 트랙의 FFmpeg 절대 스트림 인덱스. null 이면 자동 선택 */
  videoStreamIndex: number | null;
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  /** 사용자 지정 ffmpeg 경로 (없으면 번들 → PATH 순서로 탐색) */
  ffmpegPath: string | null;
  ffprobePath: string | null;
  defaults: JobSettings;
  /** 결과가 원본보다 크거나 같을 때 결과 파일을 보관할지 여부 */
  keepLargerResults: boolean;
  includeSubfoldersDefault: boolean;
  /** 출력 위치: 원본과 같은 폴더 또는 지정 폴더 */
  outputFolderMode: 'same' | 'custom';
  customOutputDir: string | null;
  /** 출력 파일명 접미사 (예: "-slim") */
  outputSuffix: string;
}

// ---------------------------------------------------------------------------
// 분석 결과
// ---------------------------------------------------------------------------

/** 값의 출처. 추측값과 확인된 값을 화면에서 구분하기 위해 사용한다. */
export type ValueSource = 'confirmed' | 'estimated' | 'unknown';

export interface MeasuredValue<T> {
  value: T | null;
  source: ValueSource;
}

export type StreamKind = 'video' | 'audio' | 'subtitle' | 'attachment' | 'data' | 'unknown';

export interface ProbeStream {
  index: number;
  kind: StreamKind;
  codecName: string;
  codecLongName: string | null;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isAttachedPic: boolean;
  // 영상 전용
  width: number | null;
  height: number | null;
  pixFmt: string | null;
  bitDepth: number | null;
  hasAlpha: boolean;
  fieldOrder: 'progressive' | 'interlaced' | 'unknown';
  /** 평균 프레임레이트 (avg_frame_rate). 확인된 값만 담는다. */
  avgFrameRate: MeasuredValue<number>;
  /** 명목 프레임레이트 (r_frame_rate). avg 와 다르면 VFR 여부를 추가 확인해야 한다. */
  nominalFrameRate: MeasuredValue<number>;
  /** 표시 회전 각도 (0, 90, 180, 270). 메타데이터 기준. */
  rotation: number;
  colorSpace: string | null;
  colorRange: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  hasDolbyVision: boolean;
  bitRate: MeasuredValue<number>;
  // 음성 전용
  channels: number | null;
  channelLayout: string | null;
  sampleRate: number | null;
  // 공통
  durationSec: MeasuredValue<number>;
  startTimeSec: number | null;
  timeBase: string | null;
  disposition: Record<string, number>;
}

export interface ProbeChapter {
  startSec: number;
  endSec: number;
  title: string | null;
}

export interface ProbeResult {
  path: string;
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;
  formatName: string;
  durationSec: MeasuredValue<number>;
  bitRate: MeasuredValue<number>;
  streams: ProbeStream[];
  chapters: ProbeChapter[];
}

export type SupportLevel = 'supported' | 'limited' | 'blocked';

export interface Limitation {
  code: string;
  severity: 'info' | 'warning' | 'blocking';
  message: string;
}

export type TrackAction = 'encode' | 'copy' | 'transcode' | 'exclude' | 'keep';

export interface TrackDecision {
  streamIndex: number;
  kind: StreamKind;
  codecName: string;
  label: string;
  action: TrackAction;
  reason: string;
}

export interface ExpectedOutput {
  /** exact: 원본 기반 계산값, estimated: 목표값·추정 범위, unknown: 샘플 분석 전 예측 불가 */
  kind: 'exact' | 'estimated' | 'unknown';
  minBytes: number | null;
  maxBytes: number | null;
  note: string;
}

export interface AnalysisResult {
  support: SupportLevel;
  primaryVideoIndex: number | null;
  limitations: Limitation[];
  tracks: TrackDecision[];
  expected: ExpectedOutput;
  /** 처리 시간 추정. history: 과거 실측 속도 기반, unknown: 측정 이력 없음 */
  timeEstimate: { kind: 'history' | 'unknown'; seconds: number | null; note: string };
  /** 목표 용량 모드에서 계산된 영상 비트레이트 (kbps). 해당 없으면 null */
  targetVideoKbps: number | null;
}

// ---------------------------------------------------------------------------
// 검증 결과
// ---------------------------------------------------------------------------

export interface ValidationCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface ValidationReport {
  passed: boolean;
  /** 기본 검증만 수행했는지 여부. true 이면 "전체 프레임 검증 완료"로 표시하지 않는다. */
  basicOnly: boolean;
  checks: ValidationCheck[];
}

// ---------------------------------------------------------------------------
// 작업 DTO (렌더러로 전달되는 형태)
// ---------------------------------------------------------------------------

export interface JobProgress {
  /** 0~1. 길이를 알 수 없으면 null (불확정 진행) */
  ratio: number | null;
  speed: number | null;
  etaSec: number | null;
  outTimeSec: number | null;
}

export interface JobView {
  id: string;
  inputPath: string;
  fileName: string;
  inputSizeBytes: number;
  status: JobStatus;
  /** 사용자에게 보여줄 한 줄 상태 설명 (예: 실패 사유 요약) */
  statusMessage: string | null;
  settings: JobSettings;
  probe: ProbeResult | null;
  analysis: AnalysisResult | null;
  progress: JobProgress;
  outputPath: string | null;
  outputSizeBytes: number | null;
  /** 실제 절감률 (0.25 = 25% 감소). 음수면 결과가 더 큼. 확정 결과가 있을 때만 값이 있다. */
  savingsRatio: number | null;
  errorCode: string | null;
  errorDetail: string | null;
  validation: ValidationReport | null;
  encoderName: string | null;
  encoderVersion: string | null;
  queuePosition: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ToolInfo {
  name: 'ffmpeg' | 'ffprobe';
  path: string | null;
  source: 'override' | 'bundled' | 'path' | 'missing';
  version: string | null;
  error: string | null;
}

export interface ToolStatus {
  ffmpeg: ToolInfo;
  ffprobe: ToolInfo;
  ready: boolean;
  /** 사용 가능한 인코더 목록 확인 결과 (현재 소프트웨어 인코더만 검사) */
  encoders: string[];
}

export interface QueueState {
  paused: boolean;
  runningJobId: string | null;
}

export interface SkippedInput {
  path: string;
  reason: string;
}

export interface AddResult {
  added: JobView[];
  skipped: SkippedInput[];
}
