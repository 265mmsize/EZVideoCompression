/**
 * 영상 편집기 추가 트랙 행: 트랙 이름과 조작 버튼, 시간 위치에 놓인 클립(끌어 옮기기·가장자리 조절),
 * 파형, 고른 클립의 키프레임 표시, 배경 음악 행.
 */
import type { ReactNode } from 'react';
import { normalizeKeyframes, trackClipDur } from '../../shared/keyframes';
import {
  ANIM_PROPS,
  type EditMusic,
  type EditTrack,
  type EditTrackClip,
} from '../../shared/types/domain';
import type { TrimEdge } from './timelineOps';
import { Waveform } from './Waveform';

export interface TrackSel {
  trackId: string;
  clipId: string;
}

/** 클립 안 키프레임 시각 (모든 속성 합집합) */
export function keyframeTimes(c: EditTrackClip): number[] {
  const all = ANIM_PROPS.flatMap((p) => c.anim[p]);
  return normalizeKeyframes(all).map((k) => k.t);
}

const smallBtn =
  'rounded border border-[var(--c-border)] bg-[var(--c-surface)] px-1 leading-4 hover:bg-[var(--c-surface-2)]';

export function TrackRows(props: {
  tracks: EditTrack[];
  pxPerSec: number;
  selected: TrackSel | null;
  onSelect: (sel: TrackSel) => void;
  onBeginMove: (trackId: string, clip: EditTrackClip, clientX: number) => void;
  onBeginTrim: (trackId: string, clip: EditTrackClip, edge: TrimEdge, clientX: number) => void;
  onAdd: (trackId: string, kind: 'video' | 'image' | 'audio') => void;
  onToggle: (trackId: string) => void;
  onRemove: (trackId: string) => void;
}): ReactNode {
  const { pxPerSec } = props;
  return (
    <>
      {props.tracks.map((track) => (
        <div
          key={track.id}
          role="list"
          aria-label={`트랙: ${track.name}`}
          className={`relative border-t border-[var(--c-border)] ${track.kind === 'audio' ? 'h-12' : 'h-14'} ${track.enabled ? '' : 'opacity-50'}`}
        >
          {/* 가로로 스크롤해도 왼쪽에 남는 트랙 머리 */}
          <div
            className="sticky left-0 z-20 flex w-max items-center gap-1 rounded-br bg-[var(--c-surface)] px-1 text-[10px]"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span className="font-semibold">{track.name}</span>
            {track.kind === 'video' ? (
              <>
                <button
                  type="button"
                  className={smallBtn}
                  onClick={() => props.onAdd(track.id, 'video')}
                >
                  + 영상
                </button>
                <button
                  type="button"
                  className={smallBtn}
                  onClick={() => props.onAdd(track.id, 'image')}
                >
                  + 이미지
                </button>
              </>
            ) : (
              <button
                type="button"
                className={smallBtn}
                onClick={() => props.onAdd(track.id, 'audio')}
              >
                + 소리
              </button>
            )}
            <button
              type="button"
              className={smallBtn}
              aria-label={`${track.name} ${track.enabled ? '끄기' : '켜기'}`}
              onClick={() => props.onToggle(track.id)}
            >
              {track.enabled ? '끄기' : '켜기'}
            </button>
            <button
              type="button"
              className={smallBtn}
              aria-label={`${track.name} 삭제`}
              onClick={() => props.onRemove(track.id)}
            >
              삭제
            </button>
          </div>
          {track.clips.map((c) => {
            const d = trackClipDur(c);
            const w = Math.max(16, d * pxPerSec);
            const isSel = props.selected?.clipId === c.id;
            return (
              <div
                key={c.id}
                role="listitem"
                aria-label={`${track.name} 클립: ${c.fileName}`}
                aria-selected={isSel}
                title={`${c.fileName} · ${c.startSec.toFixed(2)}초부터 ${d.toFixed(2)}초`}
                className={`absolute bottom-1 top-4 cursor-grab overflow-hidden rounded border text-[10px] text-black ${track.kind === 'audio' ? 'bg-emerald-200' : 'bg-violet-200'} ${isSel ? 'border-amber-500 ring-2 ring-amber-400' : 'border-[var(--c-border)]'}`}
                style={{ left: c.startSec * pxPerSec, width: w }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  props.onSelect({ trackId: track.id, clipId: c.id });
                  props.onBeginMove(track.id, c, e.clientX);
                }}
              >
                {c.kind !== 'image' && c.hasAudio && !c.mute && (
                  <Waveform
                    path={c.path}
                    fromSec={c.inSec}
                    toSec={c.outSec}
                    width={w}
                    height={track.kind === 'audio' ? 26 : 18}
                    className="bottom-0"
                  />
                )}
                <span className="relative block truncate px-2">
                  {c.kind === 'image' ? '이미지 · ' : ''}
                  {c.fileName}
                </span>
                {isSel &&
                  keyframeTimes(c).map((t) => (
                    <span
                      key={t}
                      aria-hidden
                      data-testid="keyframe-mark"
                      className="absolute top-0 h-2 w-2 -translate-x-1/2 rotate-45 bg-amber-500"
                      style={{ left: t * pxPerSec }}
                    />
                  ))}
                <div
                  className="absolute inset-y-0 left-0 w-2 cursor-ew-resize hover:bg-black/20"
                  title="시작 조절"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    props.onSelect({ trackId: track.id, clipId: c.id });
                    props.onBeginTrim(track.id, c, 'in', e.clientX);
                  }}
                />
                <div
                  className="absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-black/20"
                  title="끝 조절"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    props.onSelect({ trackId: track.id, clipId: c.id });
                    props.onBeginTrim(track.id, c, 'out', e.clientX);
                  }}
                />
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

/** 배경 음악 행: 반복이면 길이마다 파형을 되풀이해 그린다 (읽기 전용) */
export function MusicRow({
  music,
  total,
  pxPerSec,
}: {
  music: EditMusic;
  total: number;
  pxPerSec: number;
}): ReactNode {
  const dur = music.sourceDurationSec;
  const segs: { start: number; len: number }[] = [];
  if (dur > 0) {
    if (music.loop) {
      for (let s = 0; s < total && segs.length < 200; s += dur)
        segs.push({ start: s, len: Math.min(dur, total - s) });
    } else {
      segs.push({ start: 0, len: Math.min(dur, total) });
    }
  }
  return (
    <div
      role="group"
      aria-label="배경 음악"
      className="relative h-8 border-t border-[var(--c-border)]"
    >
      <span className="sticky left-0 z-20 inline-block rounded-br bg-[var(--c-surface)] px-1 text-[10px] font-semibold">
        배경 음악
      </span>
      {segs.map((s) => (
        <div
          key={s.start}
          className="absolute bottom-0.5 top-3 overflow-hidden rounded border border-[var(--c-border)] bg-sky-200 text-sky-900"
          style={{ left: s.start * pxPerSec, width: Math.max(4, s.len * pxPerSec) }}
          title={music.fileName}
        >
          <Waveform
            path={music.path}
            fromSec={0}
            toSec={s.len}
            width={Math.max(4, s.len * pxPerSec)}
            height={18}
            className="top-0"
          />
        </div>
      ))}
    </div>
  );
}
