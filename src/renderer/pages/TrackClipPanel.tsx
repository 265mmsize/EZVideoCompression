/**
 * 추가 트랙 클립 속성: 위치·사용 구간, 화면 위치·크기·불투명도, 음량, 키프레임.
 *
 * 키프레임 동작: 속성에 키프레임이 없으면 슬라이더가 고정 값을 바꾼다. 하나라도 있으면
 * 재생 헤드 시점의 키프레임을 만들거나 고친다(자동 키). ◆ 버튼은 그 시점 키프레임을 넣고 뺀다.
 */
import type { ReactNode } from 'react';
import {
  animValue,
  hasKeyframeNear,
  removeKeyframeNear,
  trackClipDur,
  upsertKeyframe,
} from '../../shared/keyframes';
import type { AnimProp, EditTrack, EditTrackClip } from '../../shared/types/domain';
import { Button } from '../components/ui';
import { moveTrackClip } from './timelineOps';
import { keyframeTimes } from './TrackRows';

interface PropSpec {
  prop: AnimProp;
  label: string;
  min: number;
  max: number;
  step: number;
}

const VISUAL: PropSpec[] = [
  { prop: 'x', label: '가로 위치', min: 0, max: 1, step: 0.01 },
  { prop: 'y', label: '세로 위치', min: 0, max: 1, step: 0.01 },
  { prop: 'scale', label: '크기', min: 0.05, max: 1.5, step: 0.01 },
  { prop: 'opacity', label: '불투명도', min: 0, max: 1, step: 0.01 },
];
const VOLUME: PropSpec = { prop: 'volume', label: '음량', min: 0, max: 2, step: 0.05 };

export function TrackClipPanel({
  track,
  clip,
  playhead,
  onChange,
  onRemove,
  onSeek,
}: {
  track: EditTrack;
  clip: EditTrackClip;
  playhead: number;
  /** key 가 같은 연속 변경은 실행 취소 한 단계로 묶인다 */
  onChange: (fn: (c: EditTrackClip) => EditTrackClip, key: string | null) => void;
  onRemove: () => void;
  onSeek: (t: number) => void;
}): ReactNode {
  const dur = trackClipDur(clip);
  const local = playhead - clip.startSec;
  const inside = local >= 0 && local <= dur + 1e-6;
  const at = Math.min(Math.max(local, 0), dur);
  const showVisual = track.kind === 'video' && clip.kind !== 'audio';
  const showAudio = clip.kind !== 'image' && clip.hasAudio;
  const specs = [...(showVisual ? VISUAL : []), ...(showAudio ? [VOLUME] : [])];
  const times = keyframeTimes(clip);
  const prev = [...times].reverse().find((t) => t < at - 0.01);
  const next = times.find((t) => t > at + 0.01);

  const setValue = (prop: AnimProp, v: number): void => {
    onChange((c) => {
      if (c.anim[prop].length === 0) return { ...c, [prop]: v };
      if (!inside) return c;
      return { ...c, anim: { ...c.anim, [prop]: upsertKeyframe(c.anim[prop], at, v) } };
    }, `tprop:${clip.id}:${prop}`);
  };
  const toggleKey = (prop: AnimProp): void => {
    if (!inside) return;
    onChange((c) => {
      const list = c.anim[prop];
      const nextList = hasKeyframeNear(list, at)
        ? removeKeyframeNear(list, at)
        : upsertKeyframe(list, at, animValue(c, prop, at));
      return { ...c, anim: { ...c.anim, [prop]: nextList } };
    }, null);
  };

  return (
    <div className="space-y-2 text-xs">
      <div className="font-semibold">
        {track.name} · {clip.fileName}
      </div>
      <label className="flex items-center justify-between gap-2">
        타임라인 시작 (초)
        <input
          type="number"
          aria-label="타임라인 시작 (초)"
          className="w-24 rounded border border-[var(--c-border)] bg-[var(--c-surface)] px-1"
          min={0}
          step={0.1}
          value={Number(clip.startSec.toFixed(3))}
          onChange={(e) =>
            onChange((c) => moveTrackClip(c, Number(e.target.value)), `tstart:${clip.id}`)
          }
        />
      </label>
      {clip.kind === 'image' ? (
        <label className="flex items-center justify-between gap-2">
          표시 길이 (초)
          <input
            type="number"
            aria-label="표시 길이 (초)"
            className="w-24 rounded border border-[var(--c-border)] bg-[var(--c-surface)] px-1"
            min={0.2}
            step={0.1}
            value={Number(dur.toFixed(3))}
            onChange={(e) =>
              onChange(
                (c) => ({ ...c, outSec: c.inSec + Math.max(0.2, Number(e.target.value) || 0.2) }),
                `tlen:${clip.id}`,
              )
            }
          />
        </label>
      ) : (
        <p className="text-[var(--c-muted)]">
          원본 {clip.inSec.toFixed(2)}–{clip.outSec.toFixed(2)}초 사용 (가장자리를 끌어 조절)
        </p>
      )}
      {showAudio && (
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={clip.mute}
            onChange={(e) =>
              onChange((c) => ({ ...c, mute: e.target.checked }), `tmute:${clip.id}`)
            }
          />
          음소거
        </label>
      )}

      <h4 className="mt-2 font-semibold text-[var(--c-muted)]">
        속성과 키프레임 {inside ? `(클립 안 ${at.toFixed(2)}초)` : ''}
      </h4>
      {!inside && (
        <p className="text-[var(--c-muted)]">
          재생 헤드가 클립 밖에 있습니다. 키프레임은 재생 헤드를 클립 안에 두고 넣습니다.
        </p>
      )}
      {specs.map((s) => {
        const value = animValue(clip, s.prop, at);
        const count = clip.anim[s.prop].length;
        const has = hasKeyframeNear(clip.anim[s.prop], at);
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
                disabled={count > 0 && !inside}
                onChange={(e) => setValue(s.prop, Number(e.target.value))}
              />
            </label>
            <button
              type="button"
              aria-label={`${s.label} 키프레임 ${has ? '지우기' : '넣기'}`}
              aria-pressed={has}
              disabled={!inside}
              title={has ? '이 시점 키프레임 지우기' : '이 시점에 키프레임 넣기'}
              className={`h-6 w-6 rounded border border-[var(--c-border)] disabled:opacity-40 ${has ? 'bg-amber-400 text-black' : ''}`}
              onClick={() => toggleKey(s.prop)}
            >
              ◆
            </button>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-1">
        <Button
          disabled={prev === undefined}
          onClick={() => prev !== undefined && onSeek(clip.startSec + prev)}
        >
          ◀ 이전 키프레임
        </Button>
        <Button
          disabled={next === undefined}
          onClick={() => next !== undefined && onSeek(clip.startSec + next)}
        >
          다음 키프레임 ▶
        </Button>
      </div>
      <Button variant="danger" onClick={onRemove}>
        이 클립 삭제
      </Button>
    </div>
  );
}
