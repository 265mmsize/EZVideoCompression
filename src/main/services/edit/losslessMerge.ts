/**
 * 무손실 합치기 판정과 인자 (순수 함수).
 * 효과 없이 파일 전체를 이어 붙이고, 영상·음성 형식이 모두 같을 때만 재인코딩 없이(-c copy) 합친다.
 * 조건이 맞지 않으면 이유를 사람이 읽는 문장으로 돌려준다.
 */
import type { EditProject, ProbeResult } from '../../../shared/types/domain';

/** 무손실로 쓸 수 있는 컨테이너 (원본 확장자 기준) */
export const LOSSLESS_EXTS = ['mp4', 'm4v', 'mov', 'mkv'] as const;
const WHOLE_FILE_TOLERANCE_SEC = 0.05;

/** 프로젝트 설정이 재인코딩을 요구하는 이유들 */
export function losslessProjectBlockers(p: EditProject): string[] {
  const out: string[] = [];
  if (p.clips.length < 2) out.push('클립이 두 개 이상이어야 합니다');
  if (p.music) out.push('배경 음악이 있습니다');
  if (p.watermark) out.push('워터마크가 있습니다');
  if (p.tracks.some((t) => t.enabled && t.clips.length > 0))
    out.push('추가 트랙에 클립이 있습니다');
  if (p.canvas.preset !== 'auto') out.push('캔버스 크기를 지정했습니다 (자동이어야 합니다)');
  if (p.canvas.fps !== 'auto') out.push('프레임 속도를 지정했습니다 (자동이어야 합니다)');
  if (p.output.normalizeAudio) out.push('클립 사이 음량 맞춤이 켜져 있습니다');
  p.clips.forEach((c, i) => {
    const name = c.fileName;
    const f = c.filters;
    const isLast = i === p.clips.length - 1;
    if (
      c.inSec > WHOLE_FILE_TOLERANCE_SEC ||
      c.outSec < c.sourceDurationSec - WHOLE_FILE_TOLERANCE_SEC
    )
      out.push(`${name}: 일부 구간만 씁니다 (파일 전체를 써야 합니다)`);
    if (c.speed !== 1) out.push(`${name}: 속도를 바꿨습니다`);
    if (c.rotate !== 0 || c.flipH || c.flipV) out.push(`${name}: 회전·반전이 있습니다`);
    if (
      f.brightness !== 0 ||
      f.contrast !== 1 ||
      f.saturation !== 1 ||
      f.sharpen !== 0 ||
      f.denoise !== 0
    )
      out.push(`${name}: 색·선명도 보정이 있습니다`);
    if (c.stabilize) out.push(`${name}: 손떨림 보정이 있습니다`);
    if (c.texts.length > 0) out.push(`${name}: 텍스트가 있습니다`);
    if (!isLast && c.transition.type !== 'none') out.push(`${name}: 전환 효과가 있습니다`);
    const m = c.motion;
    if (m && (m.zoom.length || m.panX.length || m.panY.length || m.volume.length))
      out.push(`${name}: 움직임·음량 키프레임이 있습니다`);
    if (c.volume !== 1 || c.mute) out.push(`${name}: 음량을 바꿨습니다`);
  });
  return out;
}

export interface StreamSignature {
  fileName: string;
  ext: string;
  vcodec: string | null;
  width: number | null;
  height: number | null;
  pixFmt: string | null;
  /** 평균 프레임 속도 (소수 둘째 자리) */
  fps: number | null;
  acodec: string | null;
  sampleRate: number | null;
  channels: number | null;
}

export function signatureOf(
  fileName: string,
  filePath: string,
  probe: ProbeResult,
): StreamSignature {
  const v = probe.streams.find((s) => s.kind === 'video' && !s.isAttachedPic);
  const a = probe.streams.find((s) => s.kind === 'audio');
  const fps = v?.avgFrameRate.value ?? null;
  return {
    fileName,
    ext: (filePath.split('.').pop() ?? '').toLowerCase(),
    vcodec: v?.codecName ?? null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    pixFmt: v?.pixFmt ?? null,
    fps: fps === null ? null : Math.round(fps * 100) / 100,
    acodec: a?.codecName ?? null,
    sampleRate: a?.sampleRate ?? null,
    channels: a?.channels ?? null,
  };
}

/** 받침이 있으면 '이', 없으면 '가' (한글이 아니면 '이(가)') */
export function subjectParticle(word: string): string {
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return '이(가)';
  return (code - 0xac00) % 28 === 0 ? '가' : '이';
}

/** 첫 파일과 형식이 다른 점 */
export function compatibilityReasons(sigs: readonly StreamSignature[]): string[] {
  const first = sigs[0];
  if (!first) return ['클립이 없습니다'];
  const out: string[] = [];
  if (!(LOSSLESS_EXTS as readonly string[]).includes(first.ext))
    out.push(`${first.fileName}: ${first.ext} 형식은 무손실 합치기를 지원하지 않습니다`);
  if (!first.vcodec) out.push(`${first.fileName}: 영상 트랙이 없습니다`);
  const fields: [keyof StreamSignature, string][] = [
    ['ext', '파일 형식'],
    ['vcodec', '영상 코덱'],
    ['width', '가로 크기'],
    ['height', '세로 크기'],
    ['pixFmt', '픽셀 형식'],
    ['fps', '프레임 속도'],
    ['acodec', '음성 코덱'],
    ['sampleRate', '음성 표본 주파수'],
    ['channels', '음성 채널 수'],
  ];
  for (const s of sigs.slice(1)) {
    for (const [key, label] of fields) {
      if (s[key] !== first[key]) {
        out.push(
          `${s.fileName}: ${label}${subjectParticle(label)} 첫 파일과 다릅니다 (${String(first[key] ?? '없음')} ↔ ${String(s[key] ?? '없음')})`,
        );
      }
    }
  }
  return out;
}

/** concat 분리기로 스트림을 복사해 잇는 인자 */
export function losslessArgs(
  listFile: string,
  output: string,
  ext: string,
  hasAudio: boolean,
): string[] {
  return [
    '-n',
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-map',
    '0:v:0',
    ...(hasAudio ? ['-map', '0:a:0'] : []),
    '-c',
    'copy',
    ...(ext === 'mkv' ? [] : ['-movflags', '+faststart']),
    output,
  ];
}
