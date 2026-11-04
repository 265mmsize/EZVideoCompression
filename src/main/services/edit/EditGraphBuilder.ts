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
import { evenSize as even, type Canvas } from '../../../shared/editCanvas';
import { TONEMAP_FILTERS } from './sourceColor';
import { clipDuration, FREEZE_FRAME_SEC } from '../../../shared/clipTime';
import { audioCleanFilters } from '../../../shared/audioClean';
import { hardwareEncodeArgs } from '../HardwareEncoderService';
import {
  hasZoomPan,
  keyframeExpr,
  MOTION_DEFAULTS,
  trackClipDur,
  trackSpeed,
} from '../../../shared/keyframes';
import type {
  EditClip,
  EditProject,
  EditTextOverlay,
  TransitionType,
} from '../../../shared/types/domain';

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
  /** HDR 원본이라 톤 매핑할 메인 클립 위치와 트랙 클립 id (사용자 동의 뒤에만 채운다) */
  tonemapClips?: ReadonlySet<number>;
  tonemapTrackClips?: ReadonlySet<string>;
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

export { resolveCanvas, type Canvas } from '../../../shared/editCanvas';

export const PROXY_MAX_WIDTH = 640;
/** 전환 길이는 양쪽 클립 길이의 절반을 넘지 않는다 */
const TRANSITION_MAX_RATIO = 0.5;

export function fix3(n: number): string {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}

/** 미리보기용 캔버스: 가로 640 이하로 줄인다 */
export function proxyCanvas(c: Canvas): Canvas {
  if (c.width <= PROXY_MAX_WIDTH) return c;
  const s = PROXY_MAX_WIDTH / c.width;
  return { width: even(c.width * s), height: even(c.height * s), fps: Math.min(c.fps, 30) };
}

/** 클립의 결과 길이 (속도 적용 후) */
export function clipDurationSec(c: EditClip): number {
  return clipDuration(c);
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
    // 프레임 고정: 한 프레임만 남기고 계속 반복한 뒤 길이만큼 자른다
    if (c.still)
      v.push(
        `trim=end=${fix3(FREEZE_FRAME_SEC)}`,
        'setpts=PTS-STARTPTS',
        'loop=loop=-1:size=1:start=0',
      );
    v.push(`setpts=(PTS-STARTPTS)/${fix3(c.speed)}`, `trim=duration=${fix3(dur)}`);
    if (opts.tonemapClips?.has(i)) {
      v.push(...TONEMAP_FILTERS);
      notes.push(`${c.fileName}: HDR → SDR 톤 매핑`);
    }
    if (c.rotate === 90) v.push('transpose=1');
    else if (c.rotate === 270) v.push('transpose=2');
    else if (c.rotate === 180) v.push('transpose=1', 'transpose=1');
    if (c.flipH) v.push('hflip');
    if (c.flipV) v.push('vflip');
    v.push(...fitFilters(canvas));
    // 확대·이동(켄번스): 프레임마다 키운 뒤 캔버스 크기로 잘라 낸다. 텍스트는 이 뒤에 그려 확대되지 않는다.
    if (hasZoomPan(c) && c.motion) {
      const W = String(canvas.width);
      const H = String(canvas.height);
      const z = keyframeExpr(c.motion.zoom, MOTION_DEFAULTS.zoom, 't');
      const px = keyframeExpr(c.motion.panX, MOTION_DEFAULTS.panX, 't');
      const py = keyframeExpr(c.motion.panY, MOTION_DEFAULTS.panY, 't');
      v.push(
        `scale=w='trunc(${W}*max(1,${z})/2)*2':h='trunc(${H}*max(1,${z})/2)*2':eval=frame:flags=bicubic`,
        `crop=${W}:${H}:x='(in_w-${W})*clip(${px},0,1)':y='(in_h-${H})*clip(${py},0,1)'`,
        'setsar=1',
      );
      notes.push(`${c.fileName}: 확대·이동 키프레임`);
    }
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
    // 클립 페이드 (영상): 인은 시작, 아웃은 끝에서. 텍스트까지 함께 페이드한다.
    const fi = c.fadeInSec ?? 0;
    const fo = c.fadeOutSec ?? 0;
    if (fi > 0) v.push(`fade=t=in:st=0:d=${fix3(fi)}`);
    if (fo > 0) v.push(`fade=t=out:st=${fix3(Math.max(0, dur - fo))}:d=${fix3(fo)}`);
    chains.push(`[${String(i)}:v]${v.join(',')}[v${String(i)}]`);

    // 음성 (프레임 고정 클립은 소리가 없다)
    const volKeys = c.motion?.volume ?? [];
    if (!c.still && c.hasAudio && !c.mute && (c.volume > 0 || volKeys.length > 0)) {
      const a = [
        'asetpts=PTS-STARTPTS',
        ...atempoChain(c.speed),
        // 소리 정리: 보컬 채널 연산 → 잡음 줄이기 (볼륨 전에 적용)
        ...audioCleanFilters(c),
        volKeys.length > 0
          ? `volume='${keyframeExpr(volKeys, c.volume, 't')}':eval=frame`
          : `volume=${fix3(c.volume)}`,
        // 클립 사이 음량 맞춤: 클립마다 EBU R128 -16 LUFS 로 맞춘 뒤 표본 주파수를 되돌린다
        ...(project.output.normalizeAudio
          ? ['loudnorm=I=-16:TP=-1.5:LRA=11', 'aresample=48000']
          : []),
        ...(fi > 0 ? [`afade=t=in:st=0:d=${fix3(fi)}`] : []),
        ...(fo > 0 ? [`afade=t=out:st=${fix3(Math.max(0, dur - fo))}:d=${fix3(fo)}`] : []),
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

  // ----- 추가 트랙: 영상·이미지 오버레이와 오디오 (메인 트랙 길이 안에서만) -----
  // 오버레이: 시작 위치로 시간 축을 옮기고, 투명도 → 크기 → 위치 순으로 적용한다.
  // 크기가 프레임마다 바뀐 뒤에 geq 를 두면 FFmpeg 가 비정상 종료하므로 투명도를 먼저 처리한다.
  const trackAudio: string[] = [];
  let ovIndex = 0;
  for (const track of project.tracks) {
    if (!track.enabled) continue;
    for (const tc of track.clips) {
      const start = tc.startSec;
      const dur = Math.min(trackClipDur(tc), total - start);
      if (start >= total || dur <= 0.01) continue;
      const ii = inputs.length;
      const speed = trackSpeed(tc);
      if (tc.kind === 'image') {
        inputs.push([
          '-loop',
          '1',
          '-framerate',
          String(canvas.fps),
          '-t',
          fix3(dur),
          '-i',
          tc.path,
        ]);
      } else {
        inputs.push(['-ss', fix3(tc.inSec), '-t', fix3(dur * speed), '-i', tc.path]);
      }
      const local = `(t-${fix3(start)})`;
      if (track.kind === 'video' && tc.kind !== 'audio') {
        const lbl = `ov${String(ovIndex)}`;
        const out = `vt${String(ovIndex)}`;
        ovIndex++;
        const f: string[] = [
          speed === 1
            ? `setpts=PTS-STARTPTS+${fix3(start)}/TB`
            : `setpts=(PTS-STARTPTS)/${fix3(speed)}+${fix3(start)}/TB`,
        ];
        if (opts.tonemapTrackClips?.has(tc.id)) {
          f.push(...TONEMAP_FILTERS);
          notes.push(`${tc.fileName}: HDR → SDR 톤 매핑`);
        }
        // 회전 → 반전 → 밝기·대비·채도 (메인 클립과 같은 순서), 그다음 투명도·크기
        if (tc.rotate === 90) f.push('transpose=1');
        else if (tc.rotate === 270) f.push('transpose=2');
        else if (tc.rotate === 180) f.push('transpose=1', 'transpose=1');
        if (tc.flipH) f.push('hflip');
        if (tc.flipV) f.push('vflip');
        const look = tc.filters;
        if (look && (look.brightness !== 0 || look.contrast !== 1 || look.saturation !== 1)) {
          f.push(
            `eq=brightness=${fix3(look.brightness)}:contrast=${fix3(look.contrast)}:saturation=${fix3(look.saturation)}`,
          );
        }
        f.push('format=rgba');
        if (tc.anim.opacity.length > 0) {
          const op = keyframeExpr(tc.anim.opacity, tc.opacity, `(T-${fix3(start)})`);
          f.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${op},0,1)'`);
        } else if (tc.opacity < 1) {
          f.push(`colorchannelmixer=aa=${fix3(tc.opacity)}`);
        }
        if (tc.anim.scale.length > 0) {
          const sc = keyframeExpr(tc.anim.scale, tc.scale, local);
          f.push(
            `scale=w='max(2,trunc(${String(canvas.width)}*(${sc})/2)*2)':h=-2:eval=frame:flags=bilinear`,
          );
        } else {
          f.push(`scale=${String(even(canvas.width * tc.scale))}:-2:flags=lanczos`);
        }
        chains.push(`[${String(ii)}:v]${f.join(',')}[${lbl}]`);
        const xe = `main_w*(${keyframeExpr(tc.anim.x, tc.x, local)})-overlay_w/2`;
        const ye = `main_h*(${keyframeExpr(tc.anim.y, tc.y, local)})-overlay_h/2`;
        chains.push(
          `[${vcur}][${lbl}]overlay=x='${xe}':y='${ye}':eval=frame:enable='between(t,${fix3(start)},${fix3(start + dur)})':eof_action=pass:format=auto[${out}]`,
        );
        vcur = out;
        notes.push(`${track.name}: ${tc.fileName} (${fix3(start)}초부터 ${fix3(dur)}초)`);
      }
      if (tc.kind !== 'image' && tc.hasAudio && !tc.mute) {
        const al = `ta${String(trackAudio.length)}`;
        const vol =
          tc.anim.volume.length > 0
            ? `volume='${keyframeExpr(tc.anim.volume, tc.volume, 't')}':eval=frame`
            : `volume=${fix3(tc.volume)}`;
        const ms = String(Math.round(start * 1000));
        chains.push(
          `[${String(ii)}:a]${['asetpts=PTS-STARTPTS', ...atempoChain(speed), 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo', vol, `adelay=${ms}:all=1`].join(',')}[${al}]`,
        );
        trackAudio.push(al);
        if (track.kind === 'audio')
          notes.push(`${track.name}: ${tc.fileName} (${fix3(start)}초부터)`);
      }
    }
  }
  if (trackAudio.length > 0) {
    chains.push(
      `[${aout}]${trackAudio.map((l) => `[${l}]`).join('')}amix=inputs=${String(trackAudio.length + 1)}:duration=first:dropout_transition=0:normalize=0[atr]`,
    );
    aout = 'atr';
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
/** 하드웨어 인코더 (이름과 계열). null 이면 CPU 인코더 */
export interface EditHwEncoder {
  name: string;
  family: 'nvenc' | 'qsv' | 'amf';
}

export function outputArgs(
  mode: 'proxy' | 'export',
  output: EditProject['output'],
  hw: EditHwEncoder | null = null,
): string[] {
  if (mode === 'proxy') {
    return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-c:a', 'aac', '-b:a', '96k'];
  }
  const enc = output.codec === 'h264' ? 'libx264' : 'libx265';
  // 하드웨어 인코더는 CRF 대신 인코더별 품질 값을 쓴다 (압축 기능과 같은 표). 결과는 8비트 yuv420p.
  const args = hw
    ? [...hardwareEncodeArgs(hw.name, hw.family, output.codec), '-pix_fmt', 'yuv420p']
    : ['-c:v', enc, '-preset', output.preset, '-crf', String(output.crf)];
  // 음성 제외 옵션이면 음성 인코더를 아예 쓰지 않는다 (-an)
  if (output.noAudio) args.push('-an');
  else args.push('-c:a', 'aac', '-b:a', '192k');
  if (output.codec === 'hevc' && output.container === 'mp4') args.push('-tag:v', 'hvc1');
  if (output.container === 'mp4') args.push('-movflags', '+faststart');
  return args;
}
