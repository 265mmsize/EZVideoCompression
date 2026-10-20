/**
 * 입력 특성과 설정으로부터 "지원 / 제한 / 차단" 을 판정하고 트랙별 처리 방식을 정한다.
 *
 * 순수 함수로 구현했다 (Electron·파일시스템 의존 없음). 그래서 단위 테스트로 정책을 고정할 수 있다.
 *
 * 핵심 규칙
 * - 차단(blocked): 해당 설정으로 재인코딩하면 화질·색·비트심도가 조용히 바뀌는 경우. 처리하지 않는다.
 * - 제한(limited): 처리는 가능하지만 사용자가 알아야 할 변화가 있는 경우 (예: 4:2:2 → 4:2:0).
 * - 트랙 제외는 반드시 limitations/tracks 에 사유와 함께 기록한다. 조용히 빼지 않는다.
 */
import type {
  AnalysisResult,
  JobSettings,
  Limitation,
  ProbeResult,
  ProbeStream,
  SupportLevel,
  TrackDecision,
} from '../../shared/types/domain';

/** 음성을 복사해도 되는 코덱 (출력 컨테이너별) */
const AUDIO_COPY_OK: Readonly<Record<JobSettings['container'], readonly string[]>> = {
  mp4: ['aac', 'ac3', 'eac3', 'mp3', 'alac'],
  mkv: [
    'aac',
    'ac3',
    'eac3',
    'mp3',
    'opus',
    'flac',
    'vorbis',
    'dts',
    'alac',
    'pcm_s16le',
    'pcm_s24le',
    'truehd',
  ],
};

const TEXT_SUBTITLES = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'];
const IMAGE_SUBTITLES = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'];

const HDR_TRANSFERS = ['smpte2084', 'arib-std-b67'];

/** MP4 에 그대로 넣을 수 있는 영상 코덱 */
const VIDEO_COPY_OK_MP4 = ['h264', 'hevc', 'av1'];

/** 목표 용량 모드에서 쓰는 보수적 기본값 (추정이며 화면에 "추정"으로 표시한다) */
export const ASSUMED_AUDIO_COPY_KBPS = 160;
export const TRANSCODED_AUDIO_KBPS_STEREO = 128;
export const TRANSCODED_AUDIO_KBPS_MULTI = 384;
export const CONTAINER_OVERHEAD_RATIO = 0.01;

export interface AnalyzeOptions {
  /** 과거 실측 처리 속도 (실시간 대비 배수). 없으면 시간 추정을 "이력 없음"으로 둔다. */
  historicalSpeed?: number | null;
}

export function bytesPerMiB(mib: number): number {
  return Math.round(mib * 1024 * 1024);
}

/** 주 영상 트랙 선택. 사용자 지정 인덱스가 유효하면 그것을, 아니면 default 표시 → 첫 트랙 순서로 고른다. */
export function selectPrimaryVideo(
  probe: ProbeResult,
  preferredIndex: number | null,
): ProbeStream | null {
  const videos = probe.streams.filter((s) => s.kind === 'video' && !s.isAttachedPic);
  if (preferredIndex !== null) {
    const picked = videos.find((v) => v.index === preferredIndex);
    if (picked) return picked;
  }
  return videos.find((v) => v.isDefault) ?? videos[0] ?? null;
}

export function analyzeCapability(
  probe: ProbeResult,
  settings: JobSettings,
  options: AnalyzeOptions = {},
): AnalysisResult {
  const limitations: Limitation[] = [];
  const tracks: TrackDecision[] = [];
  const reencode = settings.mode !== 'copy';
  const primary = selectPrimaryVideo(probe, settings.videoStreamIndex);

  if (!primary) {
    return blockedResult('UNSUPPORTED_INPUT', '영상 스트림이 없어 처리할 수 없습니다.', probe);
  }
  if (!primary.width || !primary.height) {
    limitations.push({
      code: 'VIDEO_SIZE_UNKNOWN',
      severity: 'blocking',
      message: '영상 해상도를 확인할 수 없어 처리를 진행하지 않습니다.',
    });
  }

  // ----- 영상 특성 -----
  if (primary.hasDolbyVision) {
    limitations.push({
      code: 'DOLBY_VISION',
      severity: reencode ? 'blocking' : 'warning',
      message: reencode
        ? 'Dolby Vision 영상은 재인코딩 경로가 검증되지 않았습니다. 원본 유지 모드만 사용할 수 있습니다.'
        : 'Dolby Vision 메타데이터가 있습니다. 컨테이너 변경 후 재생 환경에 따라 지원되지 않을 수 있습니다.',
    });
  }
  if (primary.colorTransfer && HDR_TRANSFERS.includes(primary.colorTransfer)) {
    limitations.push({
      code: 'HDR',
      severity: reencode ? 'blocking' : 'warning',
      message: reencode
        ? 'HDR 영상입니다. HDR 보존 인코딩은 아직 검증되지 않아 SDR 로 자동 변환하지 않고 처리를 차단합니다. 원본 유지 모드를 사용하세요.'
        : 'HDR 메타데이터가 있습니다. 원본 유지 모드는 스트림을 그대로 복사합니다.',
    });
  }
  if (primary.hasAlpha) {
    limitations.push({
      code: 'ALPHA',
      severity: reencode ? 'blocking' : 'warning',
      message: reencode
        ? '알파(투명) 채널이 있는 영상은 현재 H.264/H.265 출력으로 안전하게 바꿀 수 없어 차단합니다.'
        : '알파 채널이 있습니다. 출력 컨테이너에서 재생 지원 여부를 확인하세요.',
    });
  }
  if (primary.fieldOrder === 'interlaced') {
    limitations.push({
      code: 'INTERLACED',
      severity: reencode ? 'blocking' : 'warning',
      message: reencode
        ? '인터레이스 영상입니다. 디인터레이스 처리는 검증되지 않아 재인코딩을 차단합니다.'
        : '인터레이스 영상입니다. 원본 스트림을 그대로 복사합니다.',
    });
  }
  const bitDepth = primary.bitDepth ?? 8;
  if (bitDepth > 8 && settings.codec === 'h264' && reencode) {
    limitations.push({
      code: 'BITDEPTH_H264',
      severity: 'blocking',
      message: `${String(bitDepth)}비트 영상을 H.264(8비트)로 바꾸면 비트 심도가 조용히 줄어듭니다. H.265 를 선택하세요.`,
    });
  }
  if (bitDepth > 8 && settings.codec === 'h264' && !reencode) {
    limitations.push({
      code: 'BITDEPTH_COPY',
      severity: 'warning',
      message: `${String(bitDepth)}비트 H.264 스트림입니다. 재생기에 따라 재생이 되지 않을 수 있습니다.`,
    });
  }
  if (
    primary.pixFmt &&
    !/^yuv420p|^yuvj420p|^nv12|^p010|^yuv420p10/.test(primary.pixFmt) &&
    reencode
  ) {
    limitations.push({
      code: 'CHROMA_CONVERT',
      severity: 'warning',
      message: `픽셀 포맷 ${primary.pixFmt} 은 4:2:0 으로 변환됩니다. 색차 정보가 줄어들 수 있습니다.`,
    });
  }
  if (primary.rotation !== 0) {
    limitations.push({
      code: 'ROTATION',
      severity: 'info',
      message: `회전 메타데이터(${String(primary.rotation)}°)가 있습니다. 재인코딩 시 픽셀이 회전되어 출력 해상도가 바뀔 수 있습니다.`,
    });
  }
  if (
    primary.avgFrameRate.value !== null &&
    primary.nominalFrameRate.value !== null &&
    Math.abs(primary.avgFrameRate.value - primary.nominalFrameRate.value) > 0.01
  ) {
    limitations.push({
      code: 'FRAMERATE_DIFFERS',
      severity: 'info',
      message:
        '평균(avg)과 명목(r) 프레임레이트가 다릅니다. 이것만으로 가변 프레임률(VFR)이라고 단정하지 않으며, 재인코딩은 원본 타임스탬프를 유지하도록(passthrough) 설정합니다.',
    });
  }
  if (primary.durationSec.source === 'unknown') {
    limitations.push({
      code: 'DURATION_UNKNOWN',
      severity: settings.mode === 'target' ? 'blocking' : 'info',
      message:
        '재생 길이를 알 수 없습니다. 진행률은 불확정 상태로 표시되며, 목표 용량 모드는 길이가 필요하므로 차단됩니다.',
    });
  }

  // 여러 영상 트랙 처리 정책 (주 트랙 외에는 모두 제외를 명시)
  for (const v of probe.streams.filter((s) => s.kind === 'video' && s.index !== primary.index)) {
    const isCover = v.isAttachedPic;
    tracks.push({
      streamIndex: v.index,
      kind: 'video',
      codecName: v.codecName,
      label: isCover ? '커버 이미지' : '추가 영상 트랙',
      action: 'exclude',
      reason: isCover
        ? '앨범 커버 이미지는 출력에 포함하지 않습니다.'
        : '주 영상 트랙이 아니므로 출력에서 제외합니다. 주 트랙은 상세 화면에서 바꿀 수 있습니다.',
    });
  }
  tracks.unshift({
    streamIndex: primary.index,
    kind: 'video',
    codecName: primary.codecName,
    label: '주 영상',
    action: settings.mode === 'copy' ? 'copy' : 'encode',
    reason:
      settings.mode === 'copy'
        ? '영상 스트림을 재인코딩하지 않고 그대로 복사합니다.'
        : `${settings.codec === 'h264' ? 'H.264' : 'H.265'} 로 재인코딩하고 원본 해상도를 유지합니다.`,
  });

  // ----- 컨테이너 호환 (복사 모드) -----
  if (settings.mode === 'copy') {
    if (settings.container === 'mp4' && !VIDEO_COPY_OK_MP4.includes(primary.codecName)) {
      limitations.push({
        code: 'VIDEO_COPY_INCOMPATIBLE',
        severity: 'blocking',
        message: `${primary.codecName} 영상은 MP4 로 복사할 수 없습니다. MKV 를 선택하거나 재인코딩 모드를 사용하세요.`,
      });
    }
  }

  // ----- 음성 -----
  const audioOk = AUDIO_COPY_OK[settings.container];
  for (const a of probe.streams.filter((s) => s.kind === 'audio')) {
    const canCopy = audioOk.includes(a.codecName);
    const label = describeTrack('음성', a.language, a.title, a.index);
    if (settings.mode === 'copy') {
      if (!canCopy) {
        limitations.push({
          code: 'AUDIO_COPY_INCOMPATIBLE',
          severity: 'blocking',
          message: `${label}(${a.codecName})는 ${settings.container.toUpperCase()} 로 복사할 수 없습니다. 재인코딩 모드에서는 AAC 로 바꿔 포함합니다.`,
        });
      }
      tracks.push({
        streamIndex: a.index,
        kind: 'audio',
        codecName: a.codecName,
        label,
        action: canCopy ? 'copy' : 'transcode',
        reason: canCopy
          ? '호환되므로 그대로 복사합니다.'
          : '컨테이너와 호환되지 않아 복사할 수 없습니다.',
      });
    } else {
      tracks.push({
        streamIndex: a.index,
        kind: 'audio',
        codecName: a.codecName,
        label,
        action: canCopy ? 'copy' : 'transcode',
        reason: canCopy
          ? '호환되므로 음성은 복사합니다 (화질 변화 없음).'
          : `${a.codecName} 은 출력 컨테이너와 호환되지 않아 AAC 로 변환합니다 (변환 사실을 결과 화면에 표시).`,
      });
    }
  }

  // ----- 자막 -----
  for (const s of probe.streams.filter((x) => x.kind === 'subtitle')) {
    const label = describeTrack('자막', s.language, s.title, s.index);
    let action: TrackDecision['action'];
    let reason: string;
    if (settings.container === 'mp4') {
      if (TEXT_SUBTITLES.includes(s.codecName)) {
        action = 'transcode';
        reason = 'MP4 에서는 mov_text 로 변환해 포함합니다 (변환 사실 표시).';
      } else if (IMAGE_SUBTITLES.includes(s.codecName)) {
        action = 'exclude';
        reason =
          '이미지 기반 자막은 MP4 에 안전하게 넣을 수 없어 제외합니다. MKV 를 선택하면 유지됩니다.';
        limitations.push({
          code: 'IMAGE_SUBTITLE_EXCLUDED',
          severity: 'warning',
          message: `${label}(이미지 자막)이 MP4 출력에서 제외됩니다.`,
        });
      } else {
        action = 'exclude';
        reason = `${s.codecName} 자막은 MP4 출력에서 지원되지 않아 제외합니다.`;
        limitations.push({
          code: 'SUBTITLE_EXCLUDED',
          severity: 'warning',
          message: `${label}(${s.codecName})이 MP4 출력에서 제외됩니다.`,
        });
      }
    } else {
      if (s.codecName === 'mov_text') {
        action = 'transcode';
        reason = 'MKV 에서는 SRT 로 변환해 포함합니다 (변환 사실 표시).';
      } else {
        action = 'copy';
        reason = '그대로 복사합니다.';
      }
    }
    tracks.push({
      streamIndex: s.index,
      kind: 'subtitle',
      codecName: s.codecName,
      label,
      action,
      reason,
    });
  }

  // ----- 첨부 파일(폰트 등), 데이터 스트림 -----
  for (const a of probe.streams.filter((s) => s.kind === 'attachment')) {
    const keep = settings.container === 'mkv';
    tracks.push({
      streamIndex: a.index,
      kind: 'attachment',
      codecName: a.codecName,
      label: describeTrack('첨부', a.language, a.title, a.index),
      action: keep ? 'copy' : 'exclude',
      reason: keep
        ? 'MKV 첨부 파일로 그대로 유지합니다.'
        : 'MP4 는 첨부 파일을 지원하지 않아 제외합니다.',
    });
    if (!keep) {
      limitations.push({
        code: 'ATTACHMENT_EXCLUDED',
        severity: 'warning',
        message: '첨부 파일(폰트 등)이 MP4 출력에서 제외됩니다.',
      });
    }
  }
  for (const d of probe.streams.filter((s) => s.kind === 'data' || s.kind === 'unknown')) {
    tracks.push({
      streamIndex: d.index,
      kind: d.kind,
      codecName: d.codecName,
      label: describeTrack('데이터', d.language, d.title, d.index),
      action: 'exclude',
      reason: '데이터 스트림은 현재 버전에서 출력에 포함하지 않습니다.',
    });
    limitations.push({
      code: 'DATA_STREAM_EXCLUDED',
      severity: 'info',
      message: `데이터 스트림 #${String(d.index)}(${d.codecName})은 제외됩니다.`,
    });
  }

  // ----- 목표 용량 계산 -----
  let targetVideoKbps: number | null = null;
  if (settings.mode === 'target') {
    const result = computeTargetBudget(probe, settings, primary, tracks);
    targetVideoKbps = result.videoKbps;
    limitations.push(...result.limitations);
  }

  const support = levelOf(limitations);
  return {
    support,
    primaryVideoIndex: primary.index,
    limitations,
    tracks,
    expected: expectedOutput(probe, settings),
    timeEstimate: timeEstimate(probe, options.historicalSpeed ?? null),
    targetVideoKbps,
  };
}

export function levelOf(limitations: readonly Limitation[]): SupportLevel {
  if (limitations.some((l) => l.severity === 'blocking')) return 'blocked';
  if (limitations.some((l) => l.severity === 'warning')) return 'limited';
  return 'supported';
}

/**
 * 목표 용량 계산.
 * 목표 = MiB × 8 × 바이트 → 비트. 컨테이너 여유(1%)를 뺀 뒤 음성 비트를 제외한 나머지를 영상 비트레이트로 한다.
 */
export function computeTargetBudget(
  probe: ProbeResult,
  settings: JobSettings,
  primary: ProbeStream,
  tracks: readonly TrackDecision[],
): { videoKbps: number | null; limitations: Limitation[] } {
  const limitations: Limitation[] = [];
  const duration = probe.durationSec.value;
  if (settings.targetMiB === null || duration === null || duration <= 0) {
    return { videoKbps: null, limitations };
  }
  const totalBits = bytesPerMiB(settings.targetMiB) * 8 * (1 - CONTAINER_OVERHEAD_RATIO);
  let audioKbps = 0;
  for (const t of tracks.filter((x) => x.kind === 'audio' && x.action !== 'exclude')) {
    const src = probe.streams.find((s) => s.index === t.streamIndex);
    if (t.action === 'copy') {
      audioKbps += src?.bitRate.value ? src.bitRate.value / 1000 : ASSUMED_AUDIO_COPY_KBPS;
    } else {
      audioKbps +=
        (src?.channels ?? 2) <= 2 ? TRANSCODED_AUDIO_KBPS_STEREO : TRANSCODED_AUDIO_KBPS_MULTI;
    }
  }
  const audioBits = audioKbps * 1000 * duration;
  const videoKbps = (totalBits - audioBits) / duration / 1000;
  if (videoKbps <= 0) {
    limitations.push({
      code: 'TARGET_TOO_SMALL',
      severity: 'blocking',
      message: `목표 용량(${String(settings.targetMiB)} MB)이 음성 용량만으로도 부족합니다. 목표를 높이거나 음성 트랙을 줄이세요(음성 제외는 직접 선택해야 합니다).`,
    });
    return { videoKbps: null, limitations };
  }
  const width = primary.width ?? 0;
  const height = primary.height ?? 0;
  const fps = primary.avgFrameRate.value ?? primary.nominalFrameRate.value;
  if (width > 0 && height > 0) {
    const bpp = (videoKbps * 1000) / (width * height * (fps ?? 30));
    if (bpp < 0.02) {
      limitations.push({
        code: 'TARGET_LOW_QUALITY',
        severity: 'warning',
        message: `목표 용량이 작아 화질 저하가 클 수 있습니다 (예상 영상 비트레이트 ${Math.round(videoKbps)} kbps). 결과를 직접 확인하세요.`,
      });
    }
  }
  if (fps === null) {
    limitations.push({
      code: 'FPS_UNKNOWN',
      severity: 'info',
      message: '프레임레이트를 확인할 수 없어 화질 판단은 30fps 가정으로 계산했습니다.',
    });
  }
  return { videoKbps, limitations };
}

/** 예상 결과 크기. 확정값(exact)은 실제 검증 후에만 존재하므로 여기서는 쓰지 않는다. */
function expectedOutput(probe: ProbeResult, settings: JobSettings): AnalysisResult['expected'] {
  if (settings.mode === 'target') {
    if (settings.targetMiB === null) {
      return { kind: 'unknown', minBytes: null, maxBytes: null, note: '목표 용량을 입력하세요.' };
    }
    return {
      kind: 'estimated',
      minBytes: null,
      maxBytes: bytesPerMiB(settings.targetMiB),
      note: `목표 ${String(settings.targetMiB)} MB 이하를 목표로 합니다. 실제 결과는 검증 후 확정되며, 초과하면 성공으로 표시하지 않습니다.`,
    };
  }
  if (settings.mode === 'copy') {
    const dur = probe.durationSec.value;
    // bitRate 는 bps 단위다.
    const videoBps = probe.streams.find((s) => s.kind === 'video' && !s.isAttachedPic)?.bitRate
      .value;
    if (dur === null || videoBps === undefined || videoBps === null) {
      return {
        kind: 'unknown',
        minBytes: null,
        maxBytes: null,
        note: '영상 비트레이트를 알 수 없어 예상 용량을 계산할 수 없습니다.',
      };
    }
    const audioBps = probe.streams
      .filter((s) => s.kind === 'audio')
      .reduce((acc, s) => acc + (s.bitRate.value ?? ASSUMED_AUDIO_COPY_KBPS * 1000), 0);
    const bytes = ((videoBps + audioBps) * dur) / 8;
    return {
      kind: 'estimated',
      minBytes: Math.round(bytes * 0.97),
      maxBytes: Math.round(bytes * 1.03),
      note: '원본 스트림 비트레이트 기준 추정입니다. 컨테이너 변경만으로 크게 줄어들지 않으며 결과가 더 클 수도 있습니다.',
    };
  }
  return {
    kind: 'unknown',
    minBytes: null,
    maxBytes: null,
    note: '재인코딩 결과 크기는 샘플 분석 또는 실제 인코딩 전에는 예측할 수 없습니다.',
  };
}

function timeEstimate(
  probe: ProbeResult,
  historicalSpeed: number | null,
): AnalysisResult['timeEstimate'] {
  const dur = probe.durationSec.value;
  if (historicalSpeed === null || historicalSpeed <= 0) {
    return {
      kind: 'unknown',
      seconds: null,
      note: '같은 설정의 처리 이력이 없어 시간을 예측하지 않습니다.',
    };
  }
  if (dur === null) {
    return { kind: 'unknown', seconds: null, note: '길이를 알 수 없어 시간을 예측하지 않습니다.' };
  }
  return {
    kind: 'history',
    seconds: dur / historicalSpeed,
    note: `과거 실측 속도(${historicalSpeed.toFixed(2)}x) 기반 추정치입니다.`,
  };
}

function describeTrack(
  kind: string,
  lang: string | null,
  title: string | null,
  index: number,
): string {
  const parts = [`${kind} #${String(index)}`];
  if (lang) parts.push(lang);
  if (title) parts.push(title);
  return parts.join(' · ');
}

function blockedResult(code: string, message: string, probe: ProbeResult): AnalysisResult {
  return {
    support: 'blocked',
    primaryVideoIndex: null,
    limitations: [{ code, severity: 'blocking', message }],
    tracks: probe.streams.map((s) => ({
      streamIndex: s.index,
      kind: s.kind,
      codecName: s.codecName,
      label: describeTrack(s.kind, s.language, s.title, s.index),
      action: 'exclude',
      reason: '처리 불가로 제외 대상입니다.',
    })),
    expected: { kind: 'unknown', minBytes: null, maxBytes: null, note: '처리할 수 없습니다.' },
    timeEstimate: { kind: 'unknown', seconds: null, note: '처리할 수 없습니다.' },
    targetVideoKbps: null,
  };
}
