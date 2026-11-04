/**
 * 메인 클립 움직임(켄번스)과 음량 키프레임.
 * 확대·초점은 처음 움직일 때 재생 헤드 시점에 키프레임이 생긴다. 음량은 키프레임이 없으면 기본 음량을 바꾼다.
 * ◆ 로 그 시점 키프레임을 넣고 빼며, 이전·다음 키프레임으로 이동한다.
 */
import type { ReactNode } from 'react';
import {
  emptyMotion,
  hasKeyframeNear,
  motionValue,
  normalizeKeyframes,
  removeKeyframeNear,
  upsertKeyframe,
} from '../../shared/keyframes';
import { MOTION_PROPS, type EditClip, type MotionProp } from '../../shared/types/domain';
import { Button } from '../components/ui';

const SPECS: { prop: MotionProp; label: string; min: number; max: number; step: number }[] = [
  { prop: 'zoom', label: '확대', min: 1, max: 4, step: 0.01 },
  { prop: 'panX', label: '가로 초점', min: 0, max: 1, step: 0.01 },
  { prop: 'panY', label: '세로 초점', min: 0, max: 1, step: 0.01 },
  { prop: 'volume', label: '음량 키프레임', min: 0, max: 2, step: 0.05 },
];

/** 움직임 키프레임 시각 (모든 속성 합집합) */
export function motionTimes(c: EditClip): number[] {
  const m = c.motion;
  if (!m) return [];
  return normalizeKeyframes(MOTION_PROPS.flatMap((p) => m[p])).map((k) => k.t);
}

export function MotionPanel({
  clip,
  localSec,
  onChange,
  onSeek,
}: {
  clip: EditClip;
  /** 재생 헤드가 이 클립 안이면 클립 안 시간, 아니면 null */
  localSec: number | null;
  onChange: (fn: (c: EditClip) => EditClip, key: string | null) => void;
  onSeek: (localSec: number) => void;
}): ReactNode {
  const inside = localSec !== null;
  const at = localSec ?? 0;
  const motion = clip.motion ?? emptyMotion();
  const times = motionTimes(clip);
  const prev = [...times].reverse().find((t) => t < at - 0.01);
  const next = times.find((t) => t > at + 0.01);

  const setValue = (prop: MotionProp, v: number): void => {
    onChange((c) => {
      const m = c.motion ?? emptyMotion();
      if (prop === 'volume' && m.volume.length === 0) return { ...c, volume: v };
      if (!inside) return c;
      return { ...c, motion: { ...m, [prop]: upsertKeyframe(m[prop], at, v) } };
    }, `motion:${clip.id}:${prop}`);
  };
  const toggleKey = (prop: MotionProp): void => {
    if (!inside) return;
    onChange((c) => {
      const m = c.motion ?? emptyMotion();
      const list = m[prop];
      const nextList = hasKeyframeNear(list, at)
        ? removeKeyframeNear(list, at)
        : upsertKeyframe(list, at, motionValue(c, prop, at));
      return { ...c, motion: { ...m, [prop]: nextList } };
    }, null);
  };

  return (
    <section className="mt-4 space-y-2 border-t border-[var(--c-border)] pt-3 text-xs">
      <h4 className="font-semibold text-[var(--c-muted)]">
        움직임·음량 키프레임 {inside ? `(클립 안 ${at.toFixed(2)}초)` : ''}
      </h4>
      {!inside && (
        <p className="text-[var(--c-muted)]">
          재생 헤드를 이 클립 안에 두면 확대·초점·음량 키프레임을 넣을 수 있습니다.
        </p>
      )}
      {SPECS.map((s) => {
        const value = motionValue(clip, s.prop, at);
        const count = motion[s.prop].length;
        const has = hasKeyframeNear(motion[s.prop], at);
        const disabled = !inside && !(s.prop === 'volume' && count === 0);
        return (
          <div key={s.prop} className="flex items-center gap-1">
            <label className="flex min-w-0 flex-1 flex-col">
              <span>
                {s.label} {value.toFixed(2)}
                {count > 0 ? ` · 키프레임 ${String(count)}개` : ''}
              </span>
              <input
                type="range"
                aria-label={s.label}
                min={s.min}
                max={s.max}
                step={s.step}
                value={value}
                disabled={disabled}
                onChange={(e) => setValue(s.prop, Number(e.target.value))}
              />
            </label>
            <button
              type="button"
              aria-label={`${s.label} 키프레임 ${has ? '지우기' : '넣기'}`}
              aria-pressed={has}
              disabled={!inside}
              className={`h-6 w-6 rounded border border-[var(--c-border)] disabled:opacity-40 ${has ? 'bg-amber-400 text-black' : ''}`}
              onClick={() => toggleKey(s.prop)}
            >
              ◆
            </button>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-1">
        <Button disabled={prev === undefined} onClick={() => prev !== undefined && onSeek(prev)}>
          ◀ 이전 키프레임
        </Button>
        <Button disabled={next === undefined} onClick={() => next !== undefined && onSeek(next)}>
          다음 키프레임 ▶
        </Button>
        <Button
          disabled={times.length === 0}
          onClick={() => onChange((c) => ({ ...c, motion: undefined }), null)}
        >
          움직임 키프레임 모두 지우기
        </Button>
      </div>
    </section>
  );
}
