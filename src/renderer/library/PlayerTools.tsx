import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatDuration } from '../format';
import { Button } from '../components/ui';
import type { CutMode } from '../../shared/types/domain';
import { libraryApi } from './libraryActions';
import { colorPickerText } from './colorText';
import {
  addBookmark,
  bookmarkStorageKey,
  FIT_VIEW,
  FRAME_STEP_SEC,
  loopBackTarget,
  nextBookmark,
  normalizeLoop,
  PLAYBACK_RATES,
  panBy,
  parseBookmarks,
  playerAction,
  resumeStorageKey,
  shouldResume,
  stepRate,
  zoomAt,
  type LoopRange,
  type View,
} from './playerMath';
import { cueAt, parseSubtitles } from './subtitleParse';
import { screenToImagePixel } from './colorMath';

type Rotation = 0 | 90 | 180 | 270;
export interface CutSpan {
  startSec: number;
  endSec: number;
}

/** 저장된 이어보기 위치 (없거나 저장소를 못 읽으면 null) */
function readResume(id: string): number | null {
  try {
    const raw = localStorage.getItem(resumeStorageKey(id));
    return raw === null ? null : Number(raw);
  } catch {
    return null;
  }
}

function readBookmarks(id: string | null): number[] {
  if (!id) return [];
  try {
    return parseBookmarks(localStorage.getItem(bookmarkStorageKey(id)));
  } catch {
    return [];
  }
}

function writeBookmarks(id: string | null, list: number[]): void {
  if (!id) return;
  try {
    localStorage.setItem(bookmarkStorageKey(id), JSON.stringify(list));
  } catch {
    // 저장소를 못 써도 재생에는 지장이 없다
  }
}

interface Track {
  fileName: string;
  format: string;
  language: string | null;
  text: string;
}

function asFormat(f: string): 'srt' | 'webvtt' | 'ass' | 'ssa' {
  return f === 'webvtt' || f === 'ass' || f === 'ssa' ? f : 'srt';
}

/**
 * 영상 플레이어 + 보기 도구.
 * 킹플레이어 도움말의 공통 기능을 담는다: 구간 반복, 배속, 회전·반전, 확대·이동, 자막 자동 로드와 싱크,
 * 책갈피, 스크린샷, 볼륨·음소거, 이어보기, 키보드 조작. 구간 저장과 구간 목록 합치기(킹컷)도 여기에 있다.
 * 회전과 반전은 화면 표시에만 적용하며 파일을 바꾸지 않는다.
 */
export function VideoWithTools({
  src,
  srcWidth,
  srcHeight,
  onError,
  resumeKey,
  onCutRanges,
  onSaveFrame,
  onStep,
}: {
  src: string;
  srcWidth: number | null;
  srcHeight: number | null;
  onError?: () => void;
  /** 이어보기·책갈피·자막 목록을 가리키는 항목 ID. 없으면 이 기능들을 쓰지 않는다. */
  resumeKey?: string | null;
  /** 구간(들) 저장. 여러 구간이면 순서대로 합친다. 없으면 구간 저장 기능을 숨긴다. */
  onCutRanges?: (ranges: CutSpan[], mode: CutMode) => Promise<void>;
  onSaveFrame?: (timeSec: number) => Promise<void>;
  /** 이전·다음 항목으로 이동 (PgUp/PgDn) */
  onStep?: (dir: 1 | -1) => void;
}): ReactNode {
  const ref = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [rate, setRate] = useState<number>(1);
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const [loopOn, setLoopOn] = useState(false);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [now, setNow] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [cutMode, setCutMode] = useState<CutMode>('fast');
  const [cutting, setCutting] = useState(false);
  const [ranges, setRanges] = useState<CutSpan[]>([]);
  const [view, setView] = useState<View>(FIT_VIEW);
  const [subOffset, setSubOffset] = useState(0);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [trackIdx, setTrackIdx] = useState(0);
  const [bookmarks, setBookmarks] = useState<number[]>(() => readBookmarks(resumeKey ?? null));
  const drag = useRef<{ x: number; y: number } | null>(null);
  const lastSaved = useRef(0);

  const span = normalizeLoop(a, b, duration);
  const range: LoopRange | null = loopOn ? span : null;
  const cues = useMemo(() => {
    const t = tracks[trackIdx];
    return t ? parseSubtitles(t.text, asFormat(t.format)) : [];
  }, [tracks, trackIdx]);
  const cue = tracks.length > 0 ? cueAt(cues, now - subOffset) : null;

  // 같은 항목의 자막 목록을 읽는다 (화면 표시용)
  useEffect(() => {
    if (!resumeKey) return;
    let alive = true;
    void libraryApi.subtitles(resumeKey).then((list) => {
      if (alive) setTracks(list);
    });
    return () => {
      alive = false;
    };
  }, [resumeKey]);

  // 재생 속도는 요소에 직접 반영한다 (메타데이터가 바뀌어도 다시 적용)
  useEffect(() => {
    const el = ref.current;
    if (el) el.playbackRate = rate;
  }, [rate, src]);

  const saveResume = (el: HTMLVideoElement): void => {
    if (!resumeKey) return;
    const t = Date.now();
    if (t - lastSaved.current < 2000) return;
    lastSaved.current = t;
    try {
      localStorage.setItem(resumeStorageKey(resumeKey), String(el.currentTime));
    } catch {
      // 저장소를 못 써도 재생에는 지장이 없다
    }
  };
  const restoreResume = (el: HTMLVideoElement): void => {
    if (!resumeKey) return;
    const saved = readResume(resumeKey);
    if (shouldResume(saved, Number.isFinite(el.duration) ? el.duration : null)) {
      el.currentTime = saved ?? 0;
    }
  };

  const onTimeUpdate = (): void => {
    const el = ref.current;
    if (!el) return;
    setNow(el.currentTime);
    saveResume(el);
    const target = loopBackTarget(el.currentTime, normalizeLoop(a, b, el.duration));
    if (loopOn && target !== null) el.currentTime = target;
  };

  const boxSize = (): { w: number; h: number } => {
    const r = boxRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 1, h: r?.height ?? 1 };
  };

  const runAction = (action: NonNullable<ReturnType<typeof playerAction>>): void => {
    const el = ref.current;
    switch (action.type) {
      case 'toggle':
        if (!el) return;
        if (el.paused) void el.play().catch(() => undefined);
        else el.pause();
        return;
      case 'seek':
        if (!el) return;
        el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + action.deltaSec));
        return;
      case 'frame':
        if (!el) return;
        el.pause();
        el.currentTime = Math.max(
          0,
          Math.min(el.duration || 0, el.currentTime + action.dir * FRAME_STEP_SEC),
        );
        return;
      case 'rate':
        setRate((r) => stepRate(r, action.dir));
        return;
      case 'rateReset':
        setRate(1);
        return;
      case 'markA':
        if (el) setA(el.currentTime);
        return;
      case 'markB':
        if (el) setB(el.currentTime);
        return;
      case 'loop':
        if (span) setLoopOn((v) => !v);
        return;
      case 'clearRange':
        setA(null);
        setB(null);
        setLoopOn(false);
        return;
      case 'home':
        if (el) el.currentTime = 0;
        return;
      case 'rotate':
        setRotation((r) => ((((r + action.deltaDeg) % 360) + 360) % 360) as Rotation);
        return;
      case 'flipH':
        setFlipH((v) => !v);
        return;
      case 'flipV':
        setFlipV((v) => !v);
        return;
      case 'volume':
        if (el) el.volume = Math.max(0, Math.min(1, el.volume + action.delta));
        return;
      case 'mute':
        if (el) el.muted = !el.muted;
        return;
      case 'zoom': {
        const { w, h } = boxSize();
        setView((v) => zoomAt(v, action.dir > 0 ? 1.25 : 1 / 1.25, w / 2, h / 2, w, h));
        return;
      }
      case 'zoomReset':
        setView(FIT_VIEW);
        return;
      case 'subSync':
        setSubOffset((o) => Math.round((o + action.deltaSec) * 100) / 100);
        return;
      case 'subReset':
        setSubOffset(0);
        return;
      case 'subSwitch':
        if (tracks.length > 0) setTrackIdx((i) => (i + action.dir + tracks.length) % tracks.length);
        return;
      case 'bookmark':
        if (el) {
          const next = addBookmark(bookmarks, el.currentTime);
          setBookmarks(next);
          writeBookmarks(resumeKey ?? null, next);
        }
        return;
      case 'bookmarkStep': {
        if (!el) return;
        const t = nextBookmark(bookmarks, el.currentTime, action.dir);
        if (t !== null) el.currentTime = t;
        return;
      }
      case 'step':
        onStep?.(action.dir);
        return;
      case 'screenshot':
        if (el && onSaveFrame) void onSaveFrame(el.currentTime);
        return;
      default:
        return;
    }
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

  const doCut = async (list: CutSpan[]): Promise<void> => {
    if (!onCutRanges || list.length === 0) return;
    setCutting(true);
    try {
      await onCutRanges(list, cutMode);
    } finally {
      setCutting(false);
    }
  };

  const removeBookmark = (t: number): void => {
    const next = bookmarks.filter((b) => b !== t);
    setBookmarks(next);
    writeBookmarks(resumeKey ?? null, next);
  };

  return (
    <div className="space-y-1">
      <div
        ref={boxRef}
        className={`relative overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)] ${view.scale > 1 ? 'cursor-grab' : ''}`}
        style={boxStyle}
        tabIndex={0}
        aria-label="영상 보기 (키보드: Space 재생, 화살표 탐색, [ ] 구간, L 반복, + - 확대)"
        onKeyDown={(e) => {
          const action = playerAction(e.key, e.shiftKey, e.ctrlKey || e.metaKey, e.altKey);
          if (!action) return;
          e.preventDefault();
          runAction(action);
        }}
        onMouseDown={(e) => {
          if (view.scale > 1) drag.current = { x: e.clientX, y: e.clientY };
        }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const { w, h } = boxSize();
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          d.x = e.clientX;
          d.y = e.clientY;
          setView((v) => panBy(v, dx, dy, w, h));
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
      >
        <div
          className="absolute inset-0"
          style={{
            transformOrigin: '0 0',
            transform: `translate(${String(view.tx)}px, ${String(view.ty)}px) scale(${String(view.scale)})`,
          }}
        >
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
              restoreResume(el);
            }}
          >
            <track kind="captions" />
          </video>
        </div>
        {cue && (
          <div className="pointer-events-none absolute inset-x-0 bottom-14 flex justify-center px-4">
            <span
              data-testid="subtitle-text"
              className="max-w-full whitespace-pre-line rounded bg-black/70 px-2 py-1 text-center text-base text-white"
            >
              {cue.text}
            </span>
          </div>
        )}
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
            disabled={span === null}
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
        <span className="mx-1 h-4 w-px bg-[var(--c-border)]" />
        <Button onClick={() => runAction({ type: 'zoom', dir: 1 })} aria-label="확대">
          확대 +
        </Button>
        <Button onClick={() => runAction({ type: 'zoom', dir: -1 })} aria-label="축소">
          축소 -
        </Button>
        <Button onClick={() => setView(FIT_VIEW)}>원래 크기</Button>
        {onSaveFrame && (
          <Button onClick={() => ref.current && void onSaveFrame(ref.current.currentTime)}>
            스크린샷 (Ctrl+P)
          </Button>
        )}
      </div>

      {tracks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-[var(--c-muted)]">자막</span>
          <select
            aria-label="자막 선택"
            className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-0.5"
            value={String(trackIdx)}
            onChange={(e) => setTrackIdx(Number(e.target.value))}
          >
            {tracks.map((t, i) => (
              <option key={t.fileName} value={String(i)}>
                {t.fileName}
              </option>
            ))}
          </select>
          <Button onClick={() => runAction({ type: 'subSync', deltaSec: -0.5 })}>싱크 -0.5</Button>
          <span className="tabular-nums">
            {subOffset >= 0 ? '+' : ''}
            {subOffset.toFixed(1)}s
          </span>
          <Button onClick={() => runAction({ type: 'subSync', deltaSec: 0.5 })}>싱크 +0.5</Button>
          <Button onClick={() => setSubOffset(0)}>싱크 초기화</Button>
        </div>
      )}

      {resumeKey && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <Button onClick={() => runAction({ type: 'bookmark' })} aria-label="책갈피 추가">
            책갈피 추가 (B)
          </Button>
          {bookmarks.length === 0 && <span className="text-[var(--c-muted)]">책갈피 없음</span>}
          {bookmarks.map((t) => (
            <span key={t} className="flex items-center gap-0.5">
              <button
                type="button"
                className="rounded border border-[var(--c-border)] px-1.5 py-0.5 tabular-nums hover:bg-[var(--c-surface-2)]"
                onClick={() => {
                  if (ref.current) ref.current.currentTime = t;
                }}
              >
                {formatDuration(t)}
              </button>
              <button
                type="button"
                aria-label={`책갈피 ${formatDuration(t)} 삭제`}
                className="px-0.5 text-[var(--c-muted)] hover:text-[var(--c-danger)]"
                onClick={() => removeBookmark(t)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {onCutRanges && (
        <div className="space-y-2 rounded border border-[var(--c-border)] p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">구간 저장</span>
            <select
              aria-label="구간 저장 방식"
              className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-0.5"
              value={cutMode}
              onChange={(e) => setCutMode(e.target.value as CutMode)}
              disabled={cutting}
            >
              <option value="fast">빠름: 화질 그대로, 키프레임 단위</option>
              <option value="smart">스마트: 시작만 재인코딩, 나머지 무손실</option>
              <option value="exact">정확: 전부 재인코딩, 요청 시점 그대로</option>
            </select>
            <Button
              variant="primary"
              disabled={!span || cutting}
              onClick={() => span && void doCut([{ startSec: span.startSec, endSec: span.endSec }])}
            >
              {cutting
                ? '저장 중…'
                : span
                  ? `구간 잘라서 저장 (${formatDuration(span.endSec - span.startSec)})`
                  : 'A 와 B 를 먼저 찍으세요'}
            </Button>
            <Button
              disabled={!span || cutting}
              onClick={() =>
                span && setRanges((r) => [...r, { startSec: span.startSec, endSec: span.endSec }])
              }
            >
              구간 목록에 추가
            </Button>
          </div>
          {ranges.length > 0 && (
            <div className="space-y-1">
              {ranges.map((r, i) => (
                <div key={`${String(r.startSec)}-${String(i)}`} className="flex items-center gap-2">
                  <span className="tabular-nums">
                    {i + 1}. {formatDuration(r.startSec)} ~ {formatDuration(r.endSec)}
                  </span>
                  <Button onClick={() => setRanges((list) => list.filter((_, j) => j !== i))}>
                    삭제
                  </Button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Button variant="primary" disabled={cutting} onClick={() => void doCut(ranges)}>
                  목록 {ranges.length}개를 합쳐서 저장
                </Button>
                <Button onClick={() => setRanges([])}>목록 비우기</Button>
              </div>
            </div>
          )}
          <span className="block text-[var(--c-muted)]">
            원본은 바뀌지 않고 같은 폴더에 "-cut" 파일로 저장됩니다.
          </span>
        </div>
      )}
      <p className="text-xs text-[var(--c-muted)]">
        키보드(영상 클릭 후): Space 재생, ←/→ 3초, Shift 10초, Alt 1분, Ctrl+←/→ 한 프레임, Z·X·C
        배속, [ ] A/B, \ 구간 해제, L 반복, R·E 회전, Q 반대 회전, H·V 반전, ↑↓ 볼륨, M 음소거, + -
        확대, , . 자막 싱크, / 싱크 초기화, J 자막 바꾸기, B 책갈피, Shift+PgUp/PgDn 책갈피 이동,
        PgUp/PgDn 이전·다음, Ctrl+P 스크린샷.
      </p>
      {range && (
        <p className="text-xs text-[var(--c-muted)]">
          반복 구간 {formatDuration(range.startSec)} ~ {formatDuration(range.endSec)}
        </p>
      )}
    </div>
  );
}

/**
 * 확대·이동이 되는 이미지 보기 (킹뷰 줌·패닝·루페·컬러 피커).
 * - 휠로 커서 위치를 기준으로 확대, 확대 상태에서 끌어서 이동, 더블클릭으로 맞춤
 * - ← → 로 이전·다음 항목, PgUp/PgDn 도 같음
 * - I 키 또는 버튼으로 컬러 피커: 이미지를 클릭하면 그 픽셀의 RGB·HEX·HSL·HSV 를 보여 준다
 */
export function ZoomableImage({
  src,
  alt,
  itemId,
  width,
  height,
  onStep,
}: {
  src: string;
  alt: string;
  itemId?: string | null;
  /** 원본 해상도 (컬러 피커의 좌표 변환에 쓴다) */
  width?: number | null;
  height?: number | null;
  onStep?: (dir: 1 | -1) => void;
}): ReactNode {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(FIT_VIEW);
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState<{
    r: number;
    g: number;
    b: number;
    x: number;
    y: number;
  } | null>(null);
  const [pickBusy, setPickBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);

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

  const doPick = async (clientX: number, clientY: number): Promise<void> => {
    if (!itemId || !width || !height) return;
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    const p = screenToImagePixel(
      view,
      r.width,
      r.height,
      width,
      height,
      clientX - r.left,
      clientY - r.top,
    );
    if (!p) return;
    setPickBusy(true);
    try {
      const rgb = await libraryApi.pixel(itemId, p.x, p.y);
      if (rgb) setPick({ ...rgb, x: p.x, y: p.y });
    } finally {
      setPickBusy(false);
    }
  };

  return (
    <div className="space-y-1">
      <div
        ref={boxRef}
        tabIndex={0}
        aria-label="이미지 보기 (← → 이전·다음, + - 확대, I 컬러 피커)"
        className={`relative h-[60vh] w-full overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)] ${picking ? 'cursor-crosshair' : view.scale > 1 ? 'cursor-grab' : ''}`}
        onKeyDown={(e) => {
          if (
            e.key === 'ArrowLeft' ||
            e.key === 'ArrowRight' ||
            e.key === 'PageUp' ||
            e.key === 'PageDown'
          ) {
            if (!onStep) return;
            e.preventDefault();
            onStep(e.key === 'ArrowLeft' || e.key === 'PageUp' ? -1 : 1);
            return;
          }
          const action = playerAction(e.key, e.shiftKey, e.ctrlKey || e.metaKey, e.altKey);
          if (!action) return;
          if (action.type === 'zoom') {
            e.preventDefault();
            zoomBy(action.dir > 0 ? 1.25 : 1 / 1.25);
          } else if (action.type === 'zoomReset') {
            e.preventDefault();
            setView(FIT_VIEW);
          } else if (action.type === 'picker') {
            e.preventDefault();
            setPicking((v) => !v);
          }
        }}
        onMouseDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, moved: false };
        }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d || picking) return;
          if (view.scale <= 1) return;
          const { w, h } = size();
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 0) d.moved = true;
          d.x = e.clientX;
          d.y = e.clientY;
          setView((v) => panBy(v, dx, dy, w, h));
        }}
        onMouseUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (picking && d && !d.moved) void doPick(e.clientX, e.clientY);
        }}
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
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <Button onClick={() => zoomBy(1.25)} aria-label="확대">
          확대
        </Button>
        <Button onClick={() => zoomBy(1 / 1.25)} aria-label="축소">
          축소
        </Button>
        <Button onClick={() => setView(FIT_VIEW)}>맞춤</Button>
        {onStep && (
          <>
            <Button onClick={() => onStep(-1)} aria-label="이전 이미지">
              이전
            </Button>
            <Button onClick={() => onStep(1)} aria-label="다음 이미지">
              다음
            </Button>
          </>
        )}
        <Button
          variant={picking ? 'primary' : 'ghost'}
          onClick={() => setPicking((v) => !v)}
          aria-label="컬러 피커"
        >
          컬러 피커 (I)
        </Button>
        <span className="text-[var(--c-muted)]">
          {Math.round(view.scale * 100)}% · 휠 확대, 끌어 이동, 더블클릭 맞춤
        </span>
      </div>
      {picking && (
        <div
          className="rounded border border-[var(--c-border)] p-2 text-xs"
          data-testid="color-picker"
        >
          {pickBusy && <p>읽는 중…</p>}
          {!pickBusy && pick === null && (
            <p>이미지를 클릭하면 그 픽셀의 색을 원본 해상도로 읽습니다.</p>
          )}
          {pick && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-6 w-6 rounded border border-[var(--c-border)]"
                  style={{
                    background: `rgb(${String(pick.r)}, ${String(pick.g)}, ${String(pick.b)})`,
                  }}
                  aria-hidden
                />
                <span className="tabular-nums">
                  픽셀 ({pick.x}, {pick.y})
                </span>
              </div>
              <pre className="whitespace-pre-wrap font-mono">{colorPickerText(pick)}</pre>
              <Button
                onClick={() =>
                  void navigator.clipboard.writeText(colorPickerText(pick).split('\n')[0] ?? '')
                }
              >
                HEX 복사
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
