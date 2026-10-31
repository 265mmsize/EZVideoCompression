import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatDuration } from '../format';
import { Button } from '../components/ui';
import {
  FIT_VIEW,
  PLAYBACK_RATES,
  loopBackTarget,
  normalizeLoop,
  panBy,
  stepRate,
  zoomAt,
  type LoopRange,
  type View,
} from './playerMath';

type Rotation = 0 | 90 | 180 | 270;

/**
 * 영상 플레이어 + 보기 도구 (구간 반복, 재생 속도, 보기 회전·반전).
 * 회전과 반전은 화면 표시에만 적용하며 파일을 바꾸지 않는다.
 * 회전 중에는 재생 막대도 함께 돌아가 보인다 (네이티브 컨트롤의 한계).
 */
export function VideoWithTools({
  src,
  srcWidth,
  srcHeight,
  onError,
}: {
  src: string;
  srcWidth: number | null;
  srcHeight: number | null;
  onError?: () => void;
}): ReactNode {
  const ref = useRef<HTMLVideoElement>(null);
  const [rate, setRate] = useState<number>(1);
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [now, setNow] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);

  const range: LoopRange | null = loopOn ? normalizeLoop(a, b, duration) : null;

  // 재생 속도는 요소에 직접 반영한다 (메타데이터가 바뀌어도 다시 적용)
  useEffect(() => {
    const el = ref.current;
    if (el) el.playbackRate = rate;
  }, [rate, src]);

  const onTimeUpdate = (): void => {
    const el = ref.current;
    if (!el) return;
    setNow(el.currentTime);
    const target = loopBackTarget(el.currentTime, normalizeLoop(a, b, el.duration));
    if (loopOn && target !== null) el.currentTime = target;
  };

  const rotated = rotation === 90 || rotation === 270;
  const dispAspect =
    srcWidth && srcHeight ? (rotated ? srcHeight / srcWidth : srcWidth / srcHeight) : 16 / 9;
  const boxStyle: CSSProperties = {
    aspectRatio: String(dispAspect),
    maxHeight: '60vh',
    width: '100%',
    containerType: 'size',
  };
  const videoStyle: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: rotated ? '100cqh' : '100cqw',
    height: rotated ? '100cqw' : '100cqh',
    objectFit: 'contain',
    transform: `translate(-50%, -50%) rotate(${String(rotation)}deg) scale(${flipH ? -1 : 1}, ${flipV ? -1 : 1})`,
  };

  return (
    <div className="space-y-1">
      <div className="relative overflow-hidden bg-black" style={boxStyle}>
        <video
          ref={ref}
          key={src}
          src={src}
          controls
          preload="metadata"
          className="bg-black"
          style={videoStyle}
          onError={onError}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={() => {
            const el = ref.current;
            if (!el) return;
            el.playbackRate = rate;
            setDuration(Number.isFinite(el.duration) ? el.duration : null);
          }}
        >
          <track kind="captions" />
        </video>
      </div>

      <div className="flex flex-wrap items-center gap-1 text-xs">
        <Button onClick={() => setA(now)} aria-label="구간 시작 지정">
          A {a === null ? '' : formatDuration(a)}
        </Button>
        <Button onClick={() => setB(now)} aria-label="구간 끝 지정">
          B {b === null ? '' : formatDuration(b)}
        </Button>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            aria-label="구간 반복"
            checked={loopOn}
            disabled={normalizeLoop(a, b, duration) === null}
            onChange={(e) => setLoopOn(e.target.checked)}
          />
          구간 반복
        </label>
        {(a !== null || b !== null) && (
          <Button
            onClick={() => {
              setA(null);
              setB(null);
              setLoopOn(false);
            }}
          >
            구간 지우기
          </Button>
        )}
        <span className="mx-1 h-4 w-px bg-[var(--c-border)]" />
        <Button onClick={() => setRate((r) => stepRate(r, -1))} aria-label="느리게">
          느리게
        </Button>
        <select
          aria-label="재생 속도"
          className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-0.5"
          value={String(rate)}
          onChange={(e) => setRate(Number(e.target.value))}
        >
          {PLAYBACK_RATES.map((r) => (
            <option key={r} value={String(r)}>
              {r}배
            </option>
          ))}
        </select>
        <Button onClick={() => setRate((r) => stepRate(r, 1))} aria-label="빠르게">
          빠르게
        </Button>
        <span className="mx-1 h-4 w-px bg-[var(--c-border)]" />
        <Button onClick={() => setRotation(((rotation + 90) % 360) as Rotation)}>
          ↻ 회전 ({String(rotation)}°)
        </Button>
        <Button variant={flipH ? 'primary' : 'ghost'} onClick={() => setFlipH((v) => !v)}>
          좌우 반전
        </Button>
        <Button variant={flipV ? 'primary' : 'ghost'} onClick={() => setFlipV((v) => !v)}>
          상하 반전
        </Button>
      </div>
      <p className="text-xs text-[var(--c-muted)]">
        구간 반복: A와 B를 찍고 반복을 켭니다. 회전과 반전은 보기에만 적용되며 파일은 바뀌지
        않습니다.
      </p>
      {range && (
        <p className="text-xs text-[var(--c-muted)]">
          반복 구간 {formatDuration(range.startSec)} ~ {formatDuration(range.endSec)}
        </p>
      )}
    </div>
  );
}

/** 확대·이동이 되는 이미지 보기. 휠은 커서 위치를 기준으로 확대하고, 확대 상태에서 드래그로 이동한다. */
export function ZoomableImage({ src, alt }: { src: string; alt: string }): ReactNode {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT_VIEW);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      setView((v) => zoomAt(v, factor, e.clientX - r.left, e.clientY - r.top, r.width, r.height));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const size = (): { w: number; h: number } => {
    const r = boxRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 1, h: r?.height ?? 1 };
  };
  const zoomBy = (factor: number): void => {
    const { w, h } = size();
    setView((v) => zoomAt(v, factor, w / 2, h / 2, w, h));
  };

  return (
    <div className="space-y-1">
      <div
        ref={boxRef}
        className={`relative h-[60vh] w-full overflow-hidden bg-black ${view.scale > 1 ? 'cursor-grab' : ''}`}
        onMouseDown={(e) => {
          if (view.scale > 1) drag.current = { x: e.clientX, y: e.clientY };
        }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const { w, h } = size();
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          d.x = e.clientX;
          d.y = e.clientY;
          setView((v) => panBy(v, dx, dy, w, h));
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        onDoubleClick={() => setView(FIT_VIEW)}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="absolute inset-0 h-full w-full select-none object-contain"
          style={{
            transformOrigin: '0 0',
            transform: `translate(${String(view.tx)}px, ${String(view.ty)}px) scale(${String(view.scale)})`,
          }}
        />
      </div>
      <div className="flex items-center gap-1 text-xs">
        <Button onClick={() => zoomBy(1.25)} aria-label="확대">
          확대
        </Button>
        <Button onClick={() => zoomBy(1 / 1.25)} aria-label="축소">
          축소
        </Button>
        <Button onClick={() => setView(FIT_VIEW)}>맞춤</Button>
        <span className="text-[var(--c-muted)]">
          {Math.round(view.scale * 100)}% · 휠로 확대, 확대 상태에서 끌어서 이동, 더블클릭으로 맞춤
        </span>
      </div>
    </div>
  );
}
