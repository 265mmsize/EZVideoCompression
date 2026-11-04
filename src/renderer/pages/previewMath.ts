/**
 * 영상 편집 실시간 미리보기의 순수 계산.
 * 렌더 계획(EditGraphBuilder)의 규칙을 화면용으로 옮긴다: 클립 겹침과 전환 불투명도, 캔버스 안 배치,
 * 회전·반전, 밝기·대비·채도, 텍스트·워터마크 위치, 배경 음악 시간과 음량.
 * 손떨림 보정, 선명하게, 노이즈 제거, 닦기·밀기 같은 전환 모양은 화면에서 흉내 내지 않는다.
 */
import type { CSSProperties } from 'react';
import type { Canvas } from '../../shared/editCanvas';
import type {
  EditClip,
  EditClipFilters,
  EditMusic,
  EditTextOverlay,
  EditWatermark,
} from '../../shared/types/domain';
import { animValue, hasZoomPan, motionValue } from '../../shared/keyframes';
import type { EditTrackClip } from '../../shared/types/domain';
import { clipDur, layout, transitionSec } from './editOps';
import { fadeFactor } from '../../shared/clipTime';

/** 렌더의 텍스트·워터마크 여백 (캔버스 픽셀) */
const MARGIN_PX = 24;

export interface PreviewLayer {
  index: number;
  /** 클립 안의 시간 (속도 적용 후, 초) */
  localSec: number;
  /** 원본 파일 기준 시간 (초) */
  sourceSec: number;
  /** 0~1. 뒤에 오는 클립이 위에 겹친다 */
  opacity: number;
}

/**
 * 타임라인 시각 t 에 보이는 클립(최대 2개)과 불투명도.
 * 전환 구간에서는 들어오는 클립이 위에서 점점 진해진다. 검정 페이드는 앞 절반에 나가는 클립이 어두워지고
 * 뒤 절반에 들어오는 클립이 밝아진다. 끝을 넘으면 빈 배열.
 */
export function layersAt(clips: EditClip[], t: number): PreviewLayer[] {
  const { starts, total } = layout(clips);
  if (clips.length === 0 || !(t >= 0) || t >= total) return [];
  const out: PreviewLayer[] = [];
  clips.forEach((c, i) => {
    const s = starts[i] ?? 0;
    const d = clipDur(c);
    if (t < s || t >= s + d) return;
    const local = t - s;
    let opacity = 1;
    const prev = clips[i - 1];
    if (prev) {
      const tr = transitionSec(prev, c);
      if (tr > 0 && local < tr) {
        const p = local / tr;
        opacity = prev.transition.type === 'fadeblack' ? Math.max(0, 2 * p - 1) : p;
      }
    }
    const next = clips[i + 1];
    const ns = starts[i + 1];
    if (next && ns !== undefined && c.transition.type === 'fadeblack') {
      const tr = transitionSec(c, next);
      if (tr > 0 && t >= ns) opacity = Math.min(opacity, Math.max(0, 1 - (2 * (t - ns)) / tr));
    }
    // 클립 페이드 (영상과 소리 함께): 전환 배율에 곱한다
    opacity *= fadeFactor(c, local, d);
    out.push({ index: i, localSec: local, sourceSec: c.inSec + local * c.speed, opacity });
  });
  return out;
}

/** 다음 클립을 미리 불러 둘지: 지금 클립 하나만 보이고 끝까지 남은 시간이 짧을 때 */
export function preloadIndex(clips: EditClip[], t: number, aheadSec: number): number | null {
  const layers = layersAt(clips, t);
  const only = layers.length === 1 ? layers[0] : undefined;
  if (!only) return null;
  const c = clips[only.index];
  if (!c || !clips[only.index + 1]) return null;
  return clipDur(c) - only.localSec <= aheadSec ? only.index + 1 : null;
}

export interface ContentBox {
  /** 회전 전 영상 요소 크기 (캔버스 대비 %) */
  widthPct: number;
  heightPct: number;
  transform: string;
}

/**
 * 캔버스 안의 영상 배치. 렌더처럼 회전한 뒤 비율을 유지해 캔버스 안에 맞추고(확대 포함) 가운데 둔다.
 * 반전은 회전 뒤에 적용한다 (렌더: transpose → hflip/vflip).
 */
export function contentBox(c: EditClip, canvas: Pick<Canvas, 'width' | 'height'>): ContentBox {
  const swap = c.rotate === 90 || c.rotate === 270;
  const rw = swap ? c.sourceHeight : c.sourceWidth;
  const rh = swap ? c.sourceWidth : c.sourceHeight;
  const scale = Math.min(canvas.width / rw, canvas.height / rh);
  return {
    widthPct: ((c.sourceWidth * scale) / canvas.width) * 100,
    heightPct: ((c.sourceHeight * scale) / canvas.height) * 100,
    transform: `translate(-50%, -50%) scale(${c.flipH ? -1 : 1}, ${c.flipV ? -1 : 1}) rotate(${String(c.rotate)}deg)`,
  };
}

/** 밝기·대비·채도를 CSS 필터로 근사한다 (밝기는 더하기 대신 곱하기) */
export function cssFilter(f: EditClipFilters): string {
  const parts: string[] = [];
  if (f.brightness !== 0) parts.push(`brightness(${(1 + f.brightness).toFixed(3)})`);
  if (f.contrast !== 1) parts.push(`contrast(${f.contrast.toFixed(3)})`);
  if (f.saturation !== 1) parts.push(`saturate(${f.saturation.toFixed(3)})`);
  return parts.length > 0 ? parts.join(' ') : 'none';
}

/** 텍스트를 지금 보여 줄지 (렌더의 enable=between(t,start,end) 와 같다) */
export function textVisible(t: EditTextOverlay, localSec: number, clipDurSec: number): boolean {
  if (t.text.trim() === '') return false;
  const end = t.endSec === null ? clipDurSec : Math.min(t.endSec, clipDurSec);
  return localSec >= t.startSec && localSec <= end;
}

/**
 * 텍스트 위치와 크기. 글자 크기는 캔버스 높이 1080 기준이므로 상자 높이 대비 단위(cqh)로 옮긴다.
 * 여백은 렌더처럼 캔버스 24픽셀이다.
 */
export function textStyle(
  t: EditTextOverlay,
  canvas: Pick<Canvas, 'width' | 'height'>,
): CSSProperties {
  const mx = `${((MARGIN_PX / canvas.width) * 100).toFixed(3)}%`;
  const my = `${((MARGIN_PX / canvas.height) * 100).toFixed(3)}%`;
  const style: CSSProperties = {
    position: 'absolute',
    color: t.color,
    fontSize: `${(t.fontSize / 10.8).toFixed(3)}cqh`,
    lineHeight: 1.15,
    whiteSpace: 'pre',
  };
  if (t.boxed) {
    style.background = 'rgba(0,0,0,0.5)';
    style.padding = `${(10 / 10.8).toFixed(3)}cqh`;
  }
  const tx = t.x === 'center' ? '-50%' : '0';
  const ty = t.y === 'middle' ? '-50%' : '0';
  if (t.x === 'left') style.left = mx;
  else if (t.x === 'right') style.right = mx;
  else style.left = '50%';
  if (t.y === 'top') style.top = my;
  else if (t.y === 'bottom') style.bottom = my;
  else style.top = '50%';
  if (tx !== '0' || ty !== '0') style.transform = `translate(${tx}, ${ty})`;
  return style;
}

/** 워터마크 위치·크기·불투명도 (캔버스 너비 대비 크기, 여백 24픽셀) */
export function watermarkStyle(
  w: EditWatermark,
  canvas: Pick<Canvas, 'width' | 'height'>,
): CSSProperties {
  const mx = `${((MARGIN_PX / canvas.width) * 100).toFixed(3)}%`;
  const my = `${((MARGIN_PX / canvas.height) * 100).toFixed(3)}%`;
  const base: CSSProperties = {
    position: 'absolute',
    width: `${(w.scale * 100).toFixed(3)}%`,
    height: 'auto',
    opacity: w.opacity,
    pointerEvents: 'none',
  };
  switch (w.position) {
    case 'topleft':
      return { ...base, left: mx, top: my };
    case 'topright':
      return { ...base, right: mx, top: my };
    case 'bottomleft':
      return { ...base, left: mx, bottom: my };
    case 'bottomright':
      return { ...base, right: mx, bottom: my };
    case 'center':
      return { ...base, left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };
  }
}

/** 클립 음성 크기 (0~1). 배경 음악이 있으면 원본 비율을 곱한다. 100% 를 넘는 값은 미리보기에서 100% 로 들린다. */
export function clipGain(c: EditClip, music: EditMusic | null): number {
  if (!c.hasAudio || c.mute) return 0;
  return clamp01(c.volume * (music ? music.originalMix : 1));
}

/** 배경 음악의 재생 위치. 반복이 꺼져 있고 음악이 끝났으면 null */
export function musicTimeAt(m: EditMusic, t: number): number | null {
  if (!(m.sourceDurationSec > 0) || t < 0) return null;
  if (m.loop) return t % m.sourceDurationSec;
  return t < m.sourceDurationSec ? t : null;
}

/** 배경 음악 음량 (0~1): 페이드 인·아웃 포함 */
export function musicGain(m: EditMusic, t: number, total: number): number {
  let g = m.volume;
  if (m.fadeInSec > 0 && t < m.fadeInSec) g *= Math.max(0, t) / m.fadeInSec;
  if (m.fadeOutSec > 0 && t > total - m.fadeOutSec) g *= Math.max(0, total - t) / m.fadeOutSec;
  return clamp01(g);
}

/** 재생 중인 요소가 시계와 이만큼 어긋나면 다시 맞춘다 (배속이 빠르면 허용 폭도 넓힌다) */
export function needsSeek(current: number, desired: number, speed: number): boolean {
  return Math.abs(current - desired) > 0.3 * Math.max(1, speed);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * 메인 클립 확대·이동을 CSS 로. 렌더는 z 배로 키운 뒤 (z-1)·W·초점 위치에서 잘라 내는데,
 * 이는 초점 위치를 기준점으로 z 배 확대한 것과 같다. 움직임이 없으면 null.
 */
export function motionStyle(c: EditClip, localSec: number): CSSProperties | null {
  if (!hasZoomPan(c)) return null;
  const z = Math.max(1, motionValue(c, 'zoom', localSec));
  const px = clamp01(motionValue(c, 'panX', localSec));
  const py = clamp01(motionValue(c, 'panY', localSec));
  return {
    transform: `scale(${z.toFixed(4)})`,
    transformOrigin: `${(px * 100).toFixed(3)}% ${(py * 100).toFixed(3)}%`,
  };
}

/** 렌더의 잘라 내기 시작 위치 (캔버스 비율): 확대 z, 초점 p → (z-1)·p / z */
export function cropOffsetRatio(z: number, p: number): number {
  const zz = Math.max(1, z);
  return ((zz - 1) * clamp01(p)) / zz;
}

/** 메인 클립 음량 (키프레임 반영) */
export function clipVolumeAt(c: EditClip, localSec: number): number {
  return motionValue(c, 'volume', localSec);
}

export interface TrackVisual {
  left: string;
  top: string;
  width: string;
  opacity: string;
  transform: string;
  filter: string;
}

/**
 * 추가 트랙 클립의 화면 배치. 렌더는 회전한 뒤 너비를 캔버스 대비 크기로 맞추므로,
 * 90·270도 회전이면 회전 전 요소 너비를 원본 비율만큼 늘려 회전 후 너비가 같게 한다.
 */
export function trackVisual(tc: EditTrackClip, localSec: number): TrackVisual {
  const scale = animValue(tc, 'scale', localSec);
  const swap = tc.rotate === 90 || tc.rotate === 270;
  const ratio = tc.sourceWidth > 0 && tc.sourceHeight > 0 ? tc.sourceWidth / tc.sourceHeight : 1;
  const widthPct = scale * 100 * (swap ? ratio : 1);
  const f = tc.filters;
  return {
    left: `${(animValue(tc, 'x', localSec) * 100).toFixed(3)}%`,
    top: `${(animValue(tc, 'y', localSec) * 100).toFixed(3)}%`,
    width: `${widthPct.toFixed(3)}%`,
    opacity: String(clamp01(animValue(tc, 'opacity', localSec))),
    transform: `translate(-50%, -50%) scale(${tc.flipH ? -1 : 1}, ${tc.flipV ? -1 : 1}) rotate(${String(tc.rotate ?? 0)}deg)`,
    filter: f ? cssFilter({ ...f, sharpen: 0, denoise: 0 }) : 'none',
  };
}
