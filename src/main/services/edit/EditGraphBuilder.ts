/**
 * 영상 편집 프로젝트 → FFmpeg filter_complex 렌더 계획 (순수 함수, 파일시스템·Electron 비의존).
 *
 * 클립마다:
 *   입력: -ss in -t (out-in) -i 파일   (입력 단계 탐색이라 자르지 않은 부분은 디코딩하지 않는다)
 *   영상: [손떨림 보정] → 속도(setpts) → 회전·뒤집기 → 캔버스 맞춤(scale+pad) → fps → 색 보정 → 텍스트
 *   음성: 속도(atempo 체인, 음높이 유지) → 볼륨 → 길이 고정. 음성이 없으면 무음을 만든다.
 * 클립 사이: 전환 없음이면 concat, 있으면 xfade + acrossfade.
 * 배경 음악: 반복·자르기·페이드 → 원본 음성과 amix.
 * 워터마크: 이미지 입력을 overlay.
 *
 * 모든 숫자는 소수 셋째 자리로 고정해 테스트에서 문자열 비교가 가능하게 한다.
 */
import type {
  CanvasPreset,
  EditClip,
  EditProject,
  EditTextOverlay,
  TransitionType,
} from '../../../shared/types/domain';

export interface Canvas {
  width: number;
  height: number;
  fps: number;
}

export interface RenderPlanOptions {
  canvas: Canvas;
  /** 텍스트 파일을 둘 디렉터리 (drawtext textfile=). 이스케이프 문제를 피하려고 파일로 넘긴다 */
  textDir: string;
  /** 손떨림 보정 변환 파일 디렉터리 */
  trfDir: string;
  /** drawtext 글꼴 파일. null 이면 fontconfig 의 'Sans' */
  fontFile: string | null;
  /** 1-pass 의 null 출력 (플랫폼별) */
  nullSink: string;
  /** 경로 구분자. 테스트에서 고정하기 위해 주입 */
  pathSep?: '/' | '\\';
}

export interface RenderPlan {
  /** 입력별 인자 (순서 = 입력 인덱스) */
  inputs: string[][];
  filterComplex: string;
  /** 최종 출력 라벨 */
  videoLabel: string;
  audioLabel: string;
  /** 결과 길이 (초) */
  durationSec: number;
  /** 렌더 전에 써 두어야 하는 텍스트 파일 */
  textFiles: { file: string; content: string }[];
  /** 렌더 전에 실행해야 하는 손떨림 분석 패스 (클립별) */
  stabilizePasses: { clipIndex: number; args: string[]; trfFile: string }[];
  notes: string[];
}

const CANVAS_SIZES: Readonly<Record<Exclude<CanvasPreset, 'auto'>, [number, number]>> = {
  '1080p': [1920, 1080],
  '720p': [1280, 720],
  '4k': [3840, 2160],
  vertical1080: [1080, 1920],
  square1080: [1080, 1080],
};

export const PROXY_MAX_WIDTH = 640;
/** 전환 길이는 양쪽 클립 길이의 절반을 넘지 않는다 */
const TRANSITION_MAX_RATIO = 0.5;

export function fix3(n: number): string {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}

function even(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 === 0 ? r : r + 1;
}

/** 캔버스 결정. auto 는 첫 클립의 (회전 반영) 원본 크기, fps auto 는 30 */
export function resolveCanvas(project: EditProject): Canvas {
  const fps = project.canvas.fps === 'auto' ? 30 : project.canvas.fps;
  if (project.canvas.preset !== 'auto') {
    const [w, h] = CANVAS_SIZES[project.canvas.preset];
    return { width: w, height: h, fps };
  }
  const first = project.clips[0];
  if (!first) return { width: 1280, height: 720, fps };
  const swap = first.rotate === 90 || first.rotate === 270;
  const w = swap ? first.sourceHeight : first.sourceWidth;
  const h = swap ? first.sourceWidth : first.sourceHeight;
  return { width: even(w), height: even(h), fps };
}

/** 미리보기용 캔버스: 가로 640 이하로 줄인다 */
export function proxyCanvas(c: Canvas): Canvas {
  if (c.width <= PROXY_MAX_WIDTH) return c;
  const s = PROXY_MAX_WIDTH / c.width;
  return { width: even(c.width * s), height: even(c.height * s), fps: Math.min(c.fps, 30) };
}

/** 클립의 결과 길이 (속도 적용 후) */
export function clipDurationSec(c: EditClip): number {
  const src = Math.max(0, c.outSec - c.inSec);
  return src / c.speed;
}

/** 실제 쓰일 전환 길이 (양쪽 길이의 절반 이하로 제한). 전환 없음이면 0 */
export function effectiveTransitionSec(
  prevDur: number,
  next: EditClip | undefined,
  prev: EditClip,
): number {
  if (!next || prev.transition.type === 'none') return 0;
  const nextDur = clipDurationSec(next);
  const cap = Math.min(prevDur, nextDur) * TRANSITION_MAX_RATIO;
  return Math.max(0, Math.min(prev.transition.durationSec, cap));
}

/** 프로젝트 전체 길이 (전환 겹침 반영) */
export function projectDurationSec(project: EditProject): number {
  let total = 0;
  project.clips.forEach((c, i) => {
    const d = clipDurationSec(c);
    if (i === 0) {
      total = d;
      return;
    }
    const prev = project.clips[i - 1];
    if (!prev) return;
    const t = effectiveTransitionSec(clipDurationSec(prev), c, prev);
    total += d - t;
  });
  return Math.max(0, total);
}

/** 프로젝트 시간 → (클립 인덱스, 원본 시간). 미리보기 프레임 추출에 쓴다 */
export function locate(
  project: EditProject,
  timeSec: number,
): { index: number; sourceSec: number } | null {
  let start = 0;
  for (let i = 0; i < project.clips.length; i++) {
    const c = project.clips[i];
    if (!c) break;
    const d = clipDurationSec(c);
    const next = project.clips[i + 1];
    const overlap = effectiveTransitionSec(d, next, c);
    const end = start + d;
    if (timeSec < end - overlap || !next) {
      const local = Math.min(Math.max(0, timeSec - start), Math.max(0, d - 0.001));
      return { index: i, sourceSec: c.inSec + local * c.speed };
    }
    start = end - overlap;
  }
  return null;
}

/** atempo 는 0.5~2 (최근 버전은 0.5~100) 만 받으므로 체인으로 쪼갠다 */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2.000');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.500');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-6 || out.length === 0) out.push(`atempo=${fix3(s)}`);
  return out.filter((f) => f !== 'atempo=1.000' || out.length === 1);
}

/** 필터 그래프 안의 경로·문자열 인자 이스케이프 (역슬래시는 슬래시로, 구분 문자는 \\ 로) */
export function escapeFilterArg(p: string): string {
  return p.replace(/\\/g, '/').replace(/([:,;[\]'])/g, '\\$1');
}

function hexColor(hex: string): string {
  return `0x${hex.slice(1).toUpperCase()}`;
}

function textPosition(t: EditTextOverlay): { x: string; y: string } {
  const m = 24;
  const x =
    t.x === 'left' ? String(m) : t.x === 'center' ? '(w-text_w)/2' : `w-text_w-${String(m)}`;
  const y = t.y === 'top' ? String(m) : t.y === 'middle' ? '(h-text_h)/2' : `h-text_h-${String(m)}`;
  return { x, y };
}

function join(sep: '/' | '\\', dir: string, name: string): string {
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** 캔버스 맞춤: 비율을 유지해 안에 들어가게 줄이고 남는 곳은 검정으로 채운다 */
export function fitFilters(c: Canvas): string[] {
  const w = String(c.width);
  const h = String(c.height);
  return [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${String(c.fps)}`,
    'format=yuv420p',
  ];
}

export function buildRenderPlan(project: EditProject, opts: RenderPlanOptions): RenderPlan {
  const sep = opts.pathSep ?? (process.platform === 'win32' ? '\\' : '/');
  const { canvas } = opts;
  if (project.clips.length === 0) throw new Error('클립이 없습니다');
  const inputs: string[][] = [];
  const chains: string[] = [];
  const textFiles: RenderPlan['textFiles'] = [];
  const stabilizePasses: RenderPlan['stabilizePasses'] = [];
  const notes: string[] = [];
  const fontArg = opts.fontFile ? `fontfile=${escapeFilterArg(opts.fontFile)}` : 'font=Sans';
  const fontScale = canvas.height / 1080;

  // ----- 클립별 체인 -----
  project.clips.forEach((c, i) => {
    const srcDur = Math.max(0.01, c.outSec - c.inSec);
    const dur = clipDurationSec(c);
    inputs.push(['-ss', fix3(c.inSec), '-t', fix3(srcDur), '-i', c.path]);

    const v: string[] = [];
    if (c.stabilize) {
      const trf = join(sep, opts.trfDir, `clip-${String(i)}.trf`);
      stabilizePasses.push({
        clipIndex: i,
        trfFile: trf,
        args: [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          '-ss',
          fix3(c.inSec),
          '-t',
          fix3(srcDur),
          '-i',
          c.path,
          '-map',
          '0:v:0',
          '-vf',
          `vidstabdetect=result=${escapeFilterArg(trf)}:shakiness=5:accuracy=15`,
          '-f',
          'null',
          opts.nullSink,
        ],
      });
      v.push(
        `vidstabtransform=input=${escapeFilterArg(trf)}:smoothing=10:zoom=0:optzoom=1`,
        'unsharp=5:5:0.8:3:3:0.4',
      );
      notes.push(`${c.fileName}: 손떨림 보정 (2-pass, vidstab)`);
    }
    v.push(`setpts=(PTS-STARTPTS)/${fix3(c.speed)}`, `trim=duration=${fix3(dur)}`);
    if (c.rotate === 90) v.push('transpose=1');
    else if (c.rotate === 270) v.push('transpose=2');
    else if (c.rotate === 180) v.push('transpose=1', 'transpose=1');
    if (c.flipH) v.push('hflip');
    if (c.flipV) v.push('vflip');
    v.push(...fitFilters(canvas));
    const f = c.filters;
    if (f.brightness !== 0 || f.contrast !== 1 || f.saturation !== 1) {
      v.push(
        `eq=brightness=${fix3(f.brightness)}:contrast=${fix3(f.contrast)}:saturation=${fix3(f.saturation)}`,
      );
    }
    if (f.denoise > 0) v.push(`hqdn3d=${fix3(f.denoise)}:${fix3(f.denoise)}:0:0`);
    if (f.sharpen > 0) v.push(`unsharp=5:5:${fix3(f.sharpen)}:5:5:0`);
    c.texts.forEach((t, ti) => {
      if (t.text.trim() === '') return;
      const file = join(sep, opts.textDir, `clip-${String(i)}-text-${String(ti)}.txt`);
      textFiles.push({ file, content: t.text });
      const pos = textPosition(t);
      const end = t.endSec === null ? dur : Math.min(t.endSec, dur);
      const parts = [
        `textfile=${escapeFilterArg(file)}`,
        fontArg,
        `fontsize=${String(Math.max(8, Math.round(t.fontSize * fontScale)))}`,
        `fontcolor=${hexColor(t.color)}`,
        `x=${pos.x}`,
        `y=${pos.y}`,
        `enable='between(t,${fix3(t.startSec)},${fix3(end)})'`,
      ];
      if (t.boxed)
        parts.push(
          'box=1',
          'boxcolor=black@0.5',
          `boxborderw=${String(Math.round(10 * fontScale))}`,
        );
      v.push(`drawtext=${parts.join(':')}`);
    });
    chains.push(`[${String(i)}:v]${v.join(',')}[v${String(i)}]`);

    // 음성
    if (c.hasAudio && !c.mute && c.volume > 0) {
      const a = [
        'asetpts=PTS-STARTPTS',
        ...atempoChain(c.speed),
        `volume=${fix3(c.volume)}`,
        'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
        `apad=whole_dur=${fix3(dur)}`,
        `atrim=0:${fix3(dur)}`,
      ];
      chains.push(`[${String(i)}:a]${a.join(',')}[a${String(i)}]`);
    } else {
      chains.push(`anullsrc=r=48000:cl=stereo:d=${fix3(dur)}[a${String(i)}]`);
    }
  });

  // ----- 이어붙이기·전환 -----
  let vcur = 'v0';
  let acur = 'a0';
  let total = clipDurationSec(project.clips[0] as EditClip);
  for (let i = 1; i < project.clips.length; i++) {
    const prev = project.clips[i - 1] as EditClip;
    const cur = project.clips[i] as EditClip;
    const d = clipDurationSec(cur);
    const t = effectiveTransitionSec(total === 0 ? 0 : clipDurationSec(prev), cur, prev);
    const vn = `vx${String(i)}`;
    const an = `ax${String(i)}`;
    if (t <= 0) {
      chains.push(
        `[${vcur}][${acur}][v${String(i)}][a${String(i)}]concat=n=2:v=1:a=1[${vn}][${an}]`,
      );
      total += d;
    } else {
      const type: TransitionType = prev.transition.type;
      chains.push(
        `[${vcur}][v${String(i)}]xfade=transition=${type}:duration=${fix3(t)}:offset=${fix3(total - t)}[${vn}]`,
      );
      chains.push(`[${acur}][a${String(i)}]acrossfade=d=${fix3(t)}:c1=tri:c2=tri[${an}]`);
      total += d - t;
    }
    vcur = vn;
    acur = an;
  }

  // ----- 배경 음악 -----
  let aout = acur;
  if (project.music) {
    const m = project.music;
    const mi = inputs.length;
    inputs.push(['-i', m.path]);
    const a: string[] = [];
    if (m.loop) a.push('aloop=loop=-1:size=2147483647');
    a.push(
      `atrim=0:${fix3(total)}`,
      'asetpts=PTS-STARTPTS',
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      `volume=${fix3(m.volume)}`,
    );
    if (m.fadeInSec > 0) a.push(`afade=t=in:st=0:d=${fix3(m.fadeInSec)}`);
    if (m.fadeOutSec > 0)
      a.push(`afade=t=out:st=${fix3(Math.max(0, total - m.fadeOutSec))}:d=${fix3(m.fadeOutSec)}`);
    chains.push(`[${String(mi)}:a]${a.join(',')}[am]`);
    chains.push(`[${acur}]volume=${fix3(m.originalMix)}[acm]`);
    chains.push('[acm][am]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]');
    aout = 'aout';
    notes.push(`배경 음악: ${m.fileName} (원본 음성 ${String(Math.round(m.originalMix * 100))}%)`);
  }

  // ----- 워터마크 -----
  let vout = vcur;
  if (project.watermark) {
    const w = project.watermark;
    const wi = inputs.length;
    inputs.push(['-i', w.path]);
    const m = 24;
    const pos: Record<typeof w.position, string> = {
      topleft: `${String(m)}:${String(m)}`,
      topright: `main_w-overlay_w-${String(m)}:${String(m)}`,
      bottomleft: `${String(m)}:main_h-overlay_h-${String(m)}`,
      bottomright: `main_w-overlay_w-${String(m)}:main_h-overlay_h-${String(m)}`,
      center: '(main_w-overlay_w)/2:(main_h-overlay_h)/2',
    };
    chains.push(
      `[${String(wi)}:v]format=rgba,scale=${String(even(canvas.width * w.scale))}:-1:flags=lanczos,colorchannelmixer=aa=${fix3(w.opacity)}[wm]`,
    );
    chains.push(`[${vcur}][wm]overlay=${pos[w.position]}:format=auto[vout]`);
    vout = 'vout';
    notes.push(`워터마크: ${w.fileName}`);
  }

  return {
    inputs,
    filterComplex: chains.join(';'),
    videoLabel: vout,
    audioLabel: aout,
    durationSec: total,
    textFiles,
    stabilizePasses,
    notes,
  };
}

/** 출력 인코더 인자. 편집 결과는 항상 재인코딩이다 */
export function outputArgs(mode: 'proxy' | 'export', output: EditProject['output']): string[] {
  if (mode === 'proxy') {
    return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-c:a', 'aac', '-b:a', '96k'];
  }
  const enc = output.codec === 'h264' ? 'libx264' : 'libx265';
  const args = [
    '-c:v',
    enc,
    '-preset',
    output.preset,
    '-crf',
    String(output.crf),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
  ];
  if (output.codec === 'hevc' && output.container === 'mp4') args.push('-tag:v', 'hvc1');
  if (output.container === 'mp4') args.push('-movflags', '+faststart');
  return args;
}
