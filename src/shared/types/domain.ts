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
  /** 샘플 추천으로 정한 CRF. null 이면 프리셋 기본값을 쓴다 (고품질·빠른 모드에만 적용) */
  crf: number | null;
  /** 같은 폴더의 같은 이름 자막 파일(영상.srt, 영상.ko.srt 등)을 결과에 포함할지 여부 */
  externalSubtitles: boolean;
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  /** 사용자 지정 ffmpeg 경로 (없으면 번들 → PATH 순서로 탐색) */
  ffmpegPath: string | null;
  ffprobePath: string | null;
  defaults: JobSettings;
  /** 결과가 원본보다 크거나 같을 때 결과 파일을 보관할지 여부 */
  keepLargerResults: boolean;
  /** 빠른 압축에서 사용 가능한 하드웨어 인코더를 먼저 쓸지 여부 (실패 시 CPU 로 대체) */
  fastUseHardware: boolean;
  includeSubfoldersDefault: boolean;
  /** 출력 위치: 원본과 같은 폴더 또는 지정 폴더 */
  outputFolderMode: 'same' | 'custom';
  customOutputDir: string | null;
  /** 출력 파일명 접미사 (예: "-slim") */
  outputSuffix: string;
  /** 썸네일·미리보기 캐시 상한 (MiB) */
  cacheLimitMiB: number;
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
  /** 분석 시 같은 폴더에서 감지한 외부 자막 파일. 이전 버전 기록에는 없을 수 있다. */
  externalSubtitles?: DetectedSubtitle[];
}

// ---------------------------------------------------------------------------
// 외부 자막 파일
// ---------------------------------------------------------------------------

export const SUBTITLE_FORMATS = ['srt', 'ass', 'webvtt'] as const;
export type SubtitleFormat = (typeof SUBTITLE_FORMATS)[number];

/** 자막 파일의 문자 인코딩 판정. 변환은 임시 복사본에만 하고 원본 자막 파일은 수정하지 않는다. */
export type SubtitleEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'cp949' | 'unknown';

/** 분석 시점에 감지한 외부 자막 파일 (설정과 무관한 사실) */
export interface DetectedSubtitle {
  path: string;
  fileName: string;
  sizeBytes: number;
  mtimeMs: number;
  /** ffprobe 가 확인한 형식. 읽지 못했으면 null 이고 error 에 사유가 있다 */
  format: SubtitleFormat | null;
  encoding: SubtitleEncoding;
  /** 파일명 태그(영상.ko.srt → ko)에서 추정한 ISO 639-2 언어 코드 */
  language: string | null;
  error: string | null;
}

/** 설정(컨테이너, 포함 여부)을 적용한 외부 자막 처리 결정 */
export interface ExternalSubtitleDecision extends DetectedSubtitle {
  action: Extract<TrackAction, 'copy' | 'transcode' | 'exclude'>;
  reason: string;
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
  /** 외부 자막 파일 처리 결정. 이전 버전 기록에는 없을 수 있다. */
  externalSubtitles?: ExternalSubtitleDecision[];
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
  recommendation: QualityRecommendation | null;
  /** 샘플 추천이 실행 중인지 */
  sampling: boolean;
  queuePosition: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** 샘플 기반 품질 추천 결과. 샘플 구간 평가이며 전체 영상 품질 검증이 아니다. */
export interface QualityRecommendation {
  method: 'ssim';
  /** 판정 기준 (SSIM 평균이 아니라 구간별 최솟값에 적용) */
  threshold: number;
  candidates: {
    crf: number;
    /** 구간별 SSIM 의 최솟값 (0~1). 백분율이 아니다. */
    minSsim: number;
    meanSsim: number;
    /** 샘플 비트레이트로부터 추정한 전체 영상 영상(video) 용량 범위 (바이트). 확정값 아님. */
    estVideoBytesMin: number;
    estVideoBytesMax: number;
  }[];
  recommendedCrf: number;
  /** met: 기준 충족 후보 중 추천, notMet: 기준 미달이라 가장 높은 화질 후보를 추천 */
  verdict: 'met' | 'notMet';
  sampleSegments: { startSec: number; durationSec: number }[];
  sampledSec: number;
  elapsedSec: number;
  note: string;
  createdAt: string;
}

export interface ToolInfo {
  name: 'ffmpeg' | 'ffprobe';
  path: string | null;
  source: 'override' | 'bundled' | 'path' | 'missing';
  version: string | null;
  error: string | null;
}

/** 하드웨어 인코더 검사 결과. available 은 테스트 인코딩 성공 여부다 (모델 이름만으로 판단하지 않는다). */
export interface HardwareEncoderStatus {
  name: string;
  family: 'nvenc' | 'qsv' | 'amf';
  codec: VideoCodec;
  available: boolean;
  reason: string | null;
}

export interface ToolStatus {
  ffmpeg: ToolInfo;
  ffprobe: ToolInfo;
  ready: boolean;
  /** 사용 가능한 소프트웨어 인코더 목록 (libx264, libx265) */
  encoders: string[];
  hardwareEncoders: HardwareEncoderStatus[];
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

// ---------------------------------------------------------------------------
// 미디어 라이브러리 (L1~L5)
// ---------------------------------------------------------------------------

export const MEDIA_KINDS = ['video', 'image', 'other'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** 색상 라벨. 파일에는 쓰지 않고 앱 DB 에만 저장한다. */
export const MEDIA_LABELS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;
export type MediaLabel = (typeof MEDIA_LABELS)[number];

export interface LibraryRoot {
  id: string;
  path: string;
  includeSubfolders: boolean;
  addedAt: string;
  lastIndexedAt: string | null;
  itemCount: number;
}

/** 라이브러리 항목과 연결된 압축 작업 요약 (같은 입력 경로의 가장 최근 작업) */
export interface CompressionLink {
  jobId: string;
  status: JobStatus;
  outputPath: string | null;
  outputSizeBytes: number | null;
  savingsRatio: number | null;
}

export interface LibraryItem {
  id: string;
  rootId: string;
  path: string;
  fileName: string;
  /** 부모 폴더 경로 */
  parentDir: string;
  kind: MediaKind;
  sizeBytes: number;
  mtimeMs: number;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  indexedAt: string | null;
  /** 마지막 인덱싱에서 파일을 찾지 못함 */
  missing: boolean;
  errorCode: string | null;
  rating: number;
  label: MediaLabel | null;
  note: string | null;
  tags: string[];
  compression: CompressionLink | null;
}

export const LIBRARY_SORTS = ['name', 'date', 'size', 'duration', 'rating'] as const;
export type LibrarySort = (typeof LIBRARY_SORTS)[number];

export interface LibraryQuery {
  rootId: string | null;
  /** 이 폴더(와 하위 폴더) 안의 항목만 */
  dir: string | null;
  kinds: MediaKind[];
  search: string;
  minRating: number;
  label: MediaLabel | null;
  tags: string[];
  /** any: 모두, yes: 압축 작업이 있음, no: 없음 */
  compressed: 'any' | 'yes' | 'no';
  includeMissing: boolean;
  sort: LibrarySort;
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface LibraryTreeNode {
  path: string;
  name: string;
  /** 이 폴더 바로 아래 항목 수 */
  itemCount: number;
  children: LibraryTreeNode[];
}

export interface IndexingState {
  running: boolean;
  rootId: string | null;
  processed: number;
  total: number;
  currentFile: string | null;
  /** 마지막 실행의 오류 요약 */
  lastError: string | null;
}

/** 렌더러가 직접 재생할 수 있는지에 대한 판정. 확신이 아니라 코덱·컨테이너 기준의 예측이다. */
export interface PlaybackCapability {
  /** true: <video>/<img> 로 바로 열어도 됨. false: 프레임 추출 또는 프록시 경로 */
  direct: boolean;
  reason: string | null;
  /** 음성이 브라우저에서 재생 가능한지 (AC-3·DTS 는 불가) */
  audioPlayable: boolean;
  mime: string;
}

/** 재생·프레임 추출 대상. 경로는 렌더러에 노출하지 않고 메인이 해석한다. */
export type MediaRef =
  | { kind: 'item'; id: string }
  | { kind: 'job'; jobId: string; side: 'input' | 'output' }
  | { kind: 'preview'; id: string };

export interface MediaSource {
  ref: MediaRef;
  url: string;
  capability: PlaybackCapability;
  mediaKind: MediaKind;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  fileName: string;
}

export interface PreviewAsset {
  id: string;
  kind: 'proxy' | 'settings';
  /** 원본 항목 또는 작업 ID */
  sourceKey: string;
  url: string;
  sizeBytes: number;
  durationSec: number | null;
  createdAt: string;
  /** 사용자에게 보이는 설명 ("미리보기용 변환본" 등) */
  note: string;
  settings: JobSettings | null;
  startSec: number | null;
}

export interface PreviewProgress {
  previewId: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  ratio: number | null;
  asset: PreviewAsset | null;
  error: string | null;
}

export interface DuplicateGroup {
  /** 크기와 길이로 만든 그룹 키 */
  key: string;
  sizeBytes: number;
  durationSec: number | null;
  items: LibraryItem[];
  /** 해시로 확인된 동일 파일 묶음 (verify 후 채워짐) */
  hashes: Record<string, string> | null;
}

export interface CacheStats {
  thumbBytes: number;
  thumbCount: number;
  previewBytes: number;
  previewCount: number;
  limitBytes: number;
}
