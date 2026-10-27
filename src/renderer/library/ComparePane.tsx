import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { MediaRef, MediaSource } from '../../shared/types/domain';
import { formatBytes, formatDuration } from '../format';
import { Button } from '../components/ui';
import { libraryApi } from './libraryActions';

export interface CompareSide {
  label: string;
  ref: MediaRef;
  /** 이 쪽의 0초가 비교 기준 시간의 몇 초에 해당하는지 (설정 미리보기 구간 비교용) */
  offsetSec: number;
}

type ViewMode = 'side' | 'toggle' | 'wipe';

/**
 * 원본·결과 비교. 같은 기준 시점의 프레임을 양쪽에서 추출해 나란히·전환·와이프로 보여주고, 확대와 동기 스크롤을 제공한다.
 * 양쪽 모두 직접 재생이 가능하면 동기 재생도 할 수 있다.
 * 표시 기준: 프레임 비교는 "샘플 시점"이며 전체 영상 품질 판단이 아니다.
 */
export function ComparePane({
  left,
  right,
  durationSec,
}: {
  left: CompareSide;
  right: CompareSide;
  durationSec: number | null;
}): ReactNode {
  const [time, setTime] = useState(0);
  const [frames, setFrames] = useState<{ l: string | null; r: string | null }>({
    l: null,
    r: null,
  });
  const [sources, setSources] = useState<{ l: MediaSource | null; r: MediaSource | null }>({
    l: null,
    r: null,
  });
  const [mode, setMode] = useState<ViewMode>('side');
  const [showRight, setShowRight] = useState(false);
  const [wipe, setWipe] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leftVideo = useRef<HTMLVideoElement>(null);
  const rightVideo = useRef<HTMLVideoElement>(null);
  const scrollA = useRef<HTMLDivElement>(null);
  const scrollB = useRef<HTMLDivElement>(null);
  const leftKey = JSON.stringify(left.ref);
  const rightKey = JSON.stringify(right.ref);

  useEffect(() => {
    void Promise.all([
      libraryApi.source(JSON.parse(leftKey) as MediaRef),
      libraryApi.source(JSON.parse(rightKey) as MediaRef),
    ]).then(([l, r]) => setSources({ l: l ?? null, r: r ?? null }));
  }, [leftKey, rightKey]);

  const loadFrames = useCallback(
    (t: number) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setLoading(true);
        void Promise.all([
          libraryApi.frame(JSON.parse(leftKey) as MediaRef, Math.max(0, t + left.offsetSec)),
          libraryApi.frame(JSON.parse(rightKey) as MediaRef, Math.max(0, t + right.offsetSec)),
        ]).then(([l, r]) => {
          setFrames({ l: l?.url ?? null, r: r?.url ?? null });
          setLoading(false);
        });
      }, 150);
    },
    [leftKey, rightKey, left.offsetSec, right.offsetSec],
  );

  useEffect(() => {
    if (!playing) loadFrames(time);
  }, [time, playing, loadFrames]);

  const bothPlayable = Boolean(sources.l?.capability.direct && sources.r?.capability.direct);
  const max = durationSec !== null && durationSec > 0 ? Math.max(0, durationSec - 0.1) : 0;

  const syncScroll = (from: HTMLDivElement | null, to: HTMLDivElement | null): void => {
    if (!from || !to) return;
    to.scrollLeft = from.scrollLeft;
    to.scrollTop = from.scrollTop;
  };

  const togglePlay = (): void => {
    const a = leftVideo.current;
    const b = rightVideo.current;
    if (!a || !b) return;
    if (playing) {
      a.pause();
      b.pause();
      setTime(a.currentTime - left.offsetSec);
      setPlaying(false);
    } else {
      a.currentTime = time + left.offsetSec;
      b.currentTime = time + right.offsetSec;
      void a.play();
      void b.play();
      setPlaying(true);
    }
  };

  const imgStyle = { width: `${String(zoom * 100)}%`, maxWidth: 'none' as const };

  const pane = (
    url: string | null,
    label: string,
    src: MediaSource | null,
    which: 'a' | 'b',
  ): ReactNode => (
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-medium">{label}</span>
        {src && (
          <span className="text-[var(--c-muted)]">
            {src.width && src.height ? `${String(src.width)}×${String(src.height)} · ` : ''}
            {formatBytes(src.sizeBytes)}
          </span>
        )}
      </div>
      <div
        ref={which === 'a' ? scrollA : scrollB}
        onScroll={(e) =>
          syncScroll(e.currentTarget, which === 'a' ? scrollB.current : scrollA.current)
        }
        className="max-h-[55vh] overflow-auto bg-black"
      >
        {url ? (
          <img src={url} alt={`${label} 프레임`} style={imgStyle} className="block" />
        ) : (
          <div className="h-40" />
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-[var(--c-muted)]">보기</span>
        {(['side', 'toggle', 'wipe'] as ViewMode[]).map((m) => (
          <Button
            key={m}
            variant={mode === m ? 'primary' : 'ghost'}
            onClick={() => setMode(m)}
            disabled={playing}
          >
            {m === 'side' ? '나란히' : m === 'toggle' ? '전환' : '와이프'}
          </Button>
        ))}
        <span className="mx-1 h-5 w-px bg-[var(--c-border)]" aria-hidden="true" />
        <span className="text-[var(--c-muted)]">확대</span>
        {[1, 2, 4].map((z) => (
          <Button key={z} variant={zoom === z ? 'primary' : 'ghost'} onClick={() => setZoom(z)}>
            {z}×
          </Button>
        ))}
        {bothPlayable && (
          <>
            <span className="mx-1 h-5 w-px bg-[var(--c-border)]" aria-hidden="true" />
            <Button onClick={togglePlay}>{playing ? '정지 (프레임 비교로)' : '동기 재생'}</Button>
          </>
        )}
        {loading && <span className="text-xs text-[var(--c-muted)]">프레임 추출 중…</span>}
      </div>

      {playing && bothPlayable && sources.l && sources.r ? (
        <div className="flex gap-2">
          <video ref={leftVideo} src={sources.l.url} muted className="min-w-0 flex-1 bg-black" />
          <video ref={rightVideo} src={sources.r.url} muted className="min-w-0 flex-1 bg-black" />
        </div>
      ) : mode === 'side' ? (
        <div className="flex gap-2">
          {pane(frames.l, left.label, sources.l, 'a')}
          {pane(frames.r, right.label, sources.r, 'b')}
        </div>
      ) : mode === 'toggle' ? (
        <div>
          <div className="mb-1 flex gap-2">
            <Button variant={!showRight ? 'primary' : 'ghost'} onClick={() => setShowRight(false)}>
              {left.label}
            </Button>
            <Button variant={showRight ? 'primary' : 'ghost'} onClick={() => setShowRight(true)}>
              {right.label}
            </Button>
            <span className="self-center text-xs text-[var(--c-muted)]">
              키보드: 버튼에 포커스 후 Space/Enter
            </span>
          </div>
          {pane(
            showRight ? frames.r : frames.l,
            showRight ? right.label : left.label,
            showRight ? sources.r : sources.l,
            'a',
          )}
        </div>
      ) : (
        <div>
          <div className="relative max-h-[55vh] overflow-auto bg-black" ref={scrollA}>
            {frames.l && (
              <img src={frames.l} alt={`${left.label} 프레임`} style={imgStyle} className="block" />
            )}
            {frames.r && (
              <img
                src={frames.r}
                alt={`${right.label} 프레임`}
                style={{ ...imgStyle, clipPath: `inset(0 0 0 ${String(wipe)}%)` }}
                className="absolute left-0 top-0 block"
              />
            )}
            <div
              className="pointer-events-none absolute top-0 h-full w-px bg-white"
              style={{ left: `${String(wipe)}%` }}
            />
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <span>{left.label}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={wipe}
              onChange={(e) => setWipe(Number(e.target.value))}
              aria-label="와이프 위치"
              className="flex-1"
            />
            <span>{right.label}</span>
          </div>
        </div>
      )}

      {!playing && (
        <div className="flex items-center gap-2 text-xs">
          <span className="w-16 text-[var(--c-muted)]">시점</span>
          <input
            type="range"
            min={0}
            max={max}
            step={0.1}
            value={Math.min(time, max)}
            onChange={(e) => setTime(Number(e.target.value))}
            aria-label="비교 시점"
            className="flex-1"
          />
          <span className="w-24 text-right">
            {formatDuration(time)} / {formatDuration(durationSec)}
          </span>
        </div>
      )}
      <p className="text-xs text-[var(--c-muted)]">
        프레임 비교는 선택한 시점의 샘플이며 전체 영상의 품질 판단이 아닙니다. 양쪽 프레임은 같은
        기준 시점에서 추출합니다.
      </p>
    </div>
  );
}
