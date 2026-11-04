/**
 * 키프레임 계산 (순수 함수). 렌더 계획(FFmpeg 식)과 실시간 미리보기(화면 값)가 같은 규칙을 쓴다.
 * 키프레임 사이는 직선으로 잇고, 첫 키프레임 앞은 첫 값, 마지막 뒤는 마지막 값을 유지한다.
 */
import type {
  AnimProp,
  EditClip,
  EditClipMotion,
  EditKeyframe,
  EditTrackClip,
  MotionProp,
} from './types/domain';

/** 이 간격 안의 키프레임은 같은 시점으로 본다 (초) */
export const KEYFRAME_MERGE_SEC = 0.05;

/** 시간순으로 정렬하고 같은 시점은 뒤에 온 값으로 합친다 */
export function normalizeKeyframes(kfs: readonly EditKeyframe[]): EditKeyframe[] {
  const sorted = [...kfs]
    .filter((k) => Number.isFinite(k.t) && Number.isFinite(k.v))
    .map((k) => ({ t: Math.max(0, k.t), v: k.v }))
    .sort((a, b) => a.t - b.t);
  const out: EditKeyframe[] = [];
  for (const k of sorted) {
    const last = out[out.length - 1];
    if (last && k.t - last.t < KEYFRAME_MERGE_SEC) out[out.length - 1] = { t: last.t, v: k.v };
    else out.push(k);
  }
  return out;
}

/** t 시점의 값. 키프레임이 없으면 fallback */
export function valueAt(kfs: readonly EditKeyframe[], t: number, fallback: number): number {
  const k = normalizeKeyframes(kfs);
  const first = k[0];
  if (!first) return fallback;
  if (t <= first.t) return first.v;
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i];
    const b = k[i + 1];
    if (a && b && t < b.t) return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  }
  return k[k.length - 1]?.v ?? fallback;
}

function num(n: number): string {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}

/**
 * FFmpeg 식. tExpr 은 클립 안 시간을 나타내는 식 (예: "(t-12.000)").
 * 키프레임이 없으면 고정 값, 하나면 그 값, 여러 개면 구간별 직선 보간을 if(lt(...)) 로 잇는다.
 */
export function keyframeExpr(
  kfs: readonly EditKeyframe[],
  fallback: number,
  tExpr: string,
): string {
  const k = normalizeKeyframes(kfs);
  const first = k[0];
  const last = k[k.length - 1];
  if (!first || !last) return num(fallback);
  if (k.length === 1) return num(first.v);
  let e = num(last.v);
  for (let i = k.length - 2; i >= 0; i--) {
    const a = k[i];
    const b = k[i + 1];
    if (!a || !b) continue;
    const seg = `${num(a.v)}+(${num(b.v - a.v)})*(${tExpr}-${num(a.t)})/${num(b.t - a.t)}`;
    e = `if(lt(${tExpr},${num(b.t)}),${seg},${e})`;
  }
  return `if(lt(${tExpr},${num(first.t)}),${num(first.v)},${e})`;
}

/** 시점에 키프레임을 넣는다. 가까운 키프레임이 있으면 값을 바꾼다 */
export function upsertKeyframe(kfs: readonly EditKeyframe[], t: number, v: number): EditKeyframe[] {
  const near = kfs.findIndex((k) => Math.abs(k.t - t) < KEYFRAME_MERGE_SEC);
  if (near >= 0) return normalizeKeyframes(kfs.map((k, i) => (i === near ? { t: k.t, v } : k)));
  return normalizeKeyframes([...kfs, { t, v }]);
}

/** 시점 가까이의 키프레임을 지운다 */
export function removeKeyframeNear(kfs: readonly EditKeyframe[], t: number): EditKeyframe[] {
  return kfs.filter((k) => Math.abs(k.t - t) >= KEYFRAME_MERGE_SEC);
}

export function hasKeyframeNear(kfs: readonly EditKeyframe[], t: number): boolean {
  return kfs.some((k) => Math.abs(k.t - t) < KEYFRAME_MERGE_SEC);
}

/** 추가 트랙 클립 배속 (이미지는 늘 1) */
export function trackSpeed(c: Pick<EditTrackClip, 'kind' | 'speed'>): number {
  return c.kind === 'image' ? 1 : (c.speed ?? 1);
}

/** 추가 트랙 클립의 타임라인 길이 (배속 적용) */
export function trackClipDur(
  c: Pick<EditTrackClip, 'inSec' | 'outSec' | 'kind' | 'speed'>,
): number {
  return Math.max(0, c.outSec - c.inSec) / trackSpeed(c);
}

/** 클립 안 시간 localT 의 속성 값 */
export function animValue(c: EditTrackClip, prop: AnimProp, localT: number): number {
  return valueAt(c.anim[prop], localT, c[prop]);
}

/** 키프레임 시간을 offset 만큼 옮기고 [0, maxT] 밖은 버린다 (클립 앞을 잘랐을 때) */
export function shiftKeyframes(
  kfs: readonly EditKeyframe[],
  offset: number,
  maxT: number,
): EditKeyframe[] {
  return kfs
    .map((k) => ({ t: k.t + offset, v: k.v }))
    .filter((k) => k.t >= -1e-9 && k.t <= maxT + 1e-9)
    .map((k) => ({ t: Math.max(0, k.t), v: k.v }));
}

// ----- 메인 클립 움직임 (켄번스·음량) -----

/** 키프레임이 없을 때의 기본값 (음량은 클립 음량) */
export const MOTION_DEFAULTS: Readonly<Record<Exclude<MotionProp, 'volume'>, number>> = {
  zoom: 1,
  panX: 0.5,
  panY: 0.5,
};

export function emptyMotion(): EditClipMotion {
  return { zoom: [], panX: [], panY: [], volume: [] };
}

/** 메인 클립의 클립 안 시간 localT 의 움직임 값 */
export function motionValue(
  c: Pick<EditClip, 'motion' | 'volume'>,
  prop: MotionProp,
  localT: number,
): number {
  const fallback = prop === 'volume' ? c.volume : MOTION_DEFAULTS[prop];
  return valueAt(c.motion?.[prop] ?? [], localT, fallback);
}

/** 확대·이동 키프레임이 있는지 (렌더에서 scale+crop 단계를 넣을지) */
export function hasZoomPan(c: Pick<EditClip, 'motion'>): boolean {
  const m = c.motion;
  return !!m && (m.zoom.length > 0 || m.panX.length > 0 || m.panY.length > 0);
}

/** 클립을 나누거나 자를 때 움직임 키프레임을 조각에 맞춘다 */
export function shiftMotion(
  m: EditClipMotion | undefined,
  offset: number,
  maxT: number,
): EditClipMotion | undefined {
  if (!m) return undefined;
  return {
    zoom: shiftKeyframes(m.zoom, offset, maxT),
    panX: shiftKeyframes(m.panX, offset, maxT),
    panY: shiftKeyframes(m.panY, offset, maxT),
    volume: shiftKeyframes(m.volume, offset, maxT),
  };
}

/**
 * 클립 안 구간 [from, to] 만큼의 키프레임을 0 부터 시작하도록 잘라 낸다.
 * 양 끝에 그 시점의 보간 값을 키프레임으로 넣어, 조각이 원래 움직임을 그대로 이어 가게 한다.
 * to 가 무한대이면 뒤쪽은 자르지 않는다. 키프레임이 없으면 빈 배열.
 */
export function sliceKeyframes(
  kfs: readonly EditKeyframe[],
  from: number,
  to: number,
): EditKeyframe[] {
  const k = normalizeKeyframes(kfs);
  const first = k[0];
  if (!first) return [];
  const eps = 1e-6;
  const inner = k
    .filter((x) => x.t > from + eps && (!Number.isFinite(to) || x.t < to - eps))
    .map((x) => ({ t: x.t - from, v: x.v }));
  const out: EditKeyframe[] = [{ t: 0, v: valueAt(k, from, first.v) }, ...inner];
  if (Number.isFinite(to)) out.push({ t: Math.max(0, to - from), v: valueAt(k, to, first.v) });
  else {
    // 뒤를 자르지 않을 때는 원래 마지막 키프레임까지 남긴다
    const last = k[k.length - 1];
    if (last && last.t > from + eps && !inner.some((x) => Math.abs(x.t - (last.t - from)) < eps))
      out.push({ t: last.t - from, v: last.v });
  }
  return normalizeKeyframes(out);
}

/** 메인 클립 움직임 전체를 [from, to] 로 잘라 낸다 */
export function sliceMotion(
  m: EditClipMotion | undefined,
  from: number,
  to: number,
): EditClipMotion | undefined {
  if (!m) return undefined;
  return {
    zoom: sliceKeyframes(m.zoom, from, to),
    panX: sliceKeyframes(m.panX, from, to),
    panY: sliceKeyframes(m.panY, from, to),
    volume: sliceKeyframes(m.volume, from, to),
  };
}
