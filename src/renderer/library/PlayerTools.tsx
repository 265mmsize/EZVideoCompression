import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { formatDuration } from '../format';
import { Button } from '../components/ui';
import type { CutMode } from '../../shared/types/domain';
import { libraryApi } from './libraryActions';
import { notify } from '../stores/appStore';
import { colorPickerText } from './colorText';
import {
  addBookmark,
  bookmarkStorageKey,
  FIT_VIEW,
  FRAME_STEP_SEC,
  loopBackTarget,
  nextBookmark,
  nextKeyframe,
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
import {
  clampGain,
  EQ_FREQS,
  EQ_PRESETS,
  EQ_STORAGE_KEY,
  FX_LABELS,
  FX_NAMES,
  FX_STORAGE_KEY,
  fxFilter,
  sanitizeEq,
  sanitizeFx,
  type FxName,
  type FxSettings,
} from './audioFx';
import { graphFor } from './audioGraph';
import { screenToImagePixel } from './colorMath';
import { loupeBackground, regionFromDrag } from '../viewer/viewerMath';

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

/** 저장된 이퀄라이저 값 (없거나 저장소를 못 읽으면 평탄) */
function readEq(): number[] {
  try {
    return sanitizeEq(JSON.parse(localStorage.getItem(EQ_STORAGE_KEY) ?? 'null'));
  } catch {
    return sanitizeEq(null);
  }
}

/** 저장된 화면 효과 설정 (없거나 저장소를 못 읽으면 기본값) */
function readFx(): FxSettings {
  try {
    return sanitizeFx(JSON.parse(localStorage.getItem(FX_STORAGE_KEY) ?? 'null'));
  } catch {
    return sanitizeFx(null);
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
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
  const [keyframes, setKeyframes] = useState<number[]>([]);
  const [onTop, setOnTop] = useState(false);
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
  const [eqGains, setEqGains] = useState<number[]>(() => readEq());
  const [fx, setFx] = useState<FxSettings>(() => readFx());
  const [playing, setPlaying] = useState(false);
  const [level, setLevel] = useState(0);

  const span = normalizeLoop(a, b, duration);
  const range: LoopRange | null = loopOn ? span : null;
  const cues = useMemo(() => {
    const t = tracks[trackIdx];
    return t ? parseSubtitles(t.text, asFormat(t.format)) : [];
  }, [tracks, trackIdx]);
  const cue = tracks.length > 0 ? cueAt(cues, now - subOffset) : null;

  // 같은 항목의 자막 목록과 키프레임 목록을 읽는다 (화면 표시와 키프레임 이동용)
  useEffect(() => {
    if (!resumeKey) return;
    let alive = true;
    void libraryApi.subtitles(resumeKey).then((list) => {
      if (alive) setTracks(list);
    });
    void libraryApi.keyframes(resumeKey).then((list) => {
      if (alive) setKeyframes(list);
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

  // 이퀄라이저 값과 화면 효과 설정은 바뀔 때마다 저장하고, 소리 그래프에 바로 반영한다
  useEffect(() => {
    writeJson(EQ_STORAGE_KEY, eqGains);
    const el = ref.current;
    if (el) graphFor(el).setGains(eqGains);
  }, [eqGains, src]);
  useEffect(() => {
    writeJson(FX_STORAGE_KEY, fx);
  }, [fx]);

  // 재생 중에만 음량 미터를 갱신한다 (멈추면 0 으로 표시)
  useEffect(() => {
    if (!playing) return;
    const el = ref.current;
    if (!el) return;
    const g = graphFor(el);
    const id = setInterval(() => setLevel(g.level()), 200);
    return () => clearInterval(id);
  }, [playing, src]);

  // 항목이 바뀌어 영상 요소가 교체되면 이전 요소의 소리 그래프를 닫는다
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el) graphFor(el).dispose();
    };
  }, [src]);

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
      case 'keyframe': {
        if (!el) return;
        const t = nextKeyframe(keyframes, el.currentTime, action.dir);
        if (t !== null) el.currentTime = t;
        else
          notify(
            'info',
            keyframes.length === 0
              ? '키프레임 정보를 아직 읽지 못했습니다.'
              : action.dir > 0
                ? '뒤쪽에 키프레임이 없습니다.'
                : '앞쪽에 키프레임이 없습니다.',
          );
        return;
      }
      case 'alwaysOnTop':
        void libraryApi.setAlwaysOnTop(!onTop).then((r) => {
          if (!r) return;
          setOnTop(r.on);
          notify('info', `창 항상 위: ${r.on ? '켜짐' : '꺼짐'}`);
        });
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
    filter: fxFilter(fx.preset),
  };
  const eqPresetName =
    Object.keys(EQ_PRESETS).find((name) =>
      (EQ_PRESETS[name] ?? []).every((v, i) => v === (eqGains[i] ?? 0)),
    ) ?? 'custom';
  const setBand = (i: number, value: number): void => {
    setEqGains((prev) => prev.map((v, j) => (j === i ? clampGain(value) : v)));
  };
  const meter = playing ? level : 0;

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
            crossOrigin="anonymous"
            controls
            preload="metadata"
            className="bg-black"
            style={videoStyle}
            onError={onError}
            onTimeUpdate={onTimeUpdate}
            onPlay={() => {
              const el = ref.current;
              if (el) {
                const g = graphFor(el);
                // 소리 그래프는 재생 동작 안에서 만든다 (자동재생 정책 때문)
                if (g.ensure()) {
                  g.setGains(eqGains);
                  g.resume();
                }
              }
              setPlaying(true);
            }}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
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
        {fx.vignette && (
          <div
            aria-hidden
            data-testid="fx-vignette"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.65) 100%)',
            }}
          />
        )}
        {fx.scanlines && (
          <div
            aria-hidden
            data-testid="fx-scanlines"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'repeating-linear-gradient(to bottom, rgba(0,0,0,0.25) 0px, rgba(0,0,0,0.25) 1px, transparent 1px, transparent 3px)',
            }}
          />
        )}
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
      <section
        aria-label="음향과 화면 효과"
        className="space-y-2 rounded border border-[var(--c-border)] p-2 text-xs"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">이퀄라이저</span>
          <select
            aria-label="이퀄라이저 프리셋"
            className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-0.5"
            value={eqPresetName}
            onChange={(e) => {
              const p = EQ_PRESETS[e.target.value];
              if (p) setEqGains([...p]);
            }}
          >
            {Object.keys(EQ_PRESETS).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            {eqPresetName === 'custom' && <option value="custom">직접 조절</option>}
          </select>
          <Button onClick={() => setEqGains([...(EQ_PRESETS['평탄'] ?? [])])}>
            이퀄라이저 초기화
          </Button>
          <span
            data-testid="audio-meter"
            data-level={meter.toFixed(3)}
            className="flex items-center gap-1 text-[var(--c-muted)]"
          >
            음량
            <span className="inline-block h-2 w-24 overflow-hidden rounded bg-[var(--c-surface-2)]">
              <span
                className="block h-full bg-emerald-500"
                style={{ width: `${String(Math.min(100, Math.round(meter * 300)))}%` }}
              />
            </span>
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {EQ_FREQS.map((f, i) => {
            const g = eqGains[i] ?? 0;
            return (
              <label key={f} className="flex flex-col items-center gap-1">
                <span className="tabular-nums">
                  {g > 0 ? '+' : ''}
                  {g.toFixed(1)}
                </span>
                <input
                  type="range"
                  aria-label={`${String(f)} Hz`}
                  min={-12}
                  max={12}
                  step={0.5}
                  value={g}
                  onChange={(e) => setBand(i, Number(e.target.value))}
                  className="h-24 w-5"
                  style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                />
                <span className="text-[var(--c-muted)]">
                  {f >= 1000 ? `${String(f / 1000)}k` : String(f)}
                </span>
              </label>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">화면 효과</span>
          <select
            aria-label="화면 효과"
            className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-0.5"
            value={fx.preset}
            onChange={(e) => setFx((s) => ({ ...s, preset: e.target.value as FxName }))}
          >
            {FX_NAMES.map((n) => (
              <option key={n} value={n}>
                {FX_LABELS[n]}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={fx.vignette}
              onChange={(e) => setFx((s) => ({ ...s, vignette: e.target.checked }))}
            />
            가장자리 어둡게
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={fx.scanlines}
              onChange={(e) => setFx((s) => ({ ...s, scanlines: e.target.checked }))}
            />
            스캔라인
          </label>
        </div>
        <span className="block text-[var(--c-muted)]">
          설정은 이 PC에 저장됩니다. 소리 처리와 화면 효과는 재생 화면에만 적용되며 원본 파일은
          바뀌지 않습니다.
        </span>
      </section>
      <p className="text-xs text-[var(--c-muted)]">
        키보드(영상 클릭 후): Space 재생, ←/→ 3초, Shift 10초, Alt 1분, Ctrl+←/→ 한 프레임, Z·X·C
        배속, [ ] A/B, \ 구간 해제, L 반복, R·E 회전, Q 반대 회전, H·V 반전, ↑↓ 볼륨, M 음소거, + -
        확대, , . 자막 싱크, / 싱크 초기화, J 자막 바꾸기, B 책갈피, Shift+PgUp/PgDn 책갈피 이동,
        PgUp/PgDn 이전·다음, Ctrl+P 스크린샷, Ctrl+Shift+←/→ 키프레임 이동, Ctrl+T 창 항상 위.
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
 * 확대·이동이 되는 이미지 보기 (킹뷰 줌·패닝·루페·영역 저장·컬러 피커).
 * - 휠로 커서 위치 기준 확대, 확대 상태에서 끌어서 이동, 더블클릭으로 맞춤
 * - 누르고 있으면 루페(돋보기), Ctrl+드래그로 영역 선택 후 저장 (onSaveRegion 이 있을 때)
 * - ← → 로 이전·다음 항목, I 키 또는 버튼으로 컬러 피커
 */
export function ZoomableImage({
  src,
  alt,
  itemId,
  width,
  height,
  onStep,
  onSaveRegion,
}: {
  src: string;
  alt: string;
  itemId?: string | null;
  /** 원본 해상도 (컬러 피커와 영역 좌표 변환에 쓴다) */
  width?: number | null;
  height?: number | null;
  onStep?: (dir: 1 | -1) => void;
  /** 영역 저장. 원본 픽셀 사각형을 넘긴다. 없으면 영역 선택을 쓰지 않는다. */
  onSaveRegion?: (rect: { x: number; y: number; width: number; height: number }) => void;
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
  const [boxSize, setBoxSize] = useState({ w: 1, h: 1 });
  const [loupe, setLoupe] = useState<{ x: number; y: number } | null>(null);
  const [region, setRegion] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LOUPE_RADIUS = 80;
  const LOUPE_ZOOM = 3;

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = (): void => setBoxSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      setView((v) => zoomAt(v, factor, e.clientX - r.left, e.clientY - r.top, r.width, r.height));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      ro.disconnect();
    };
  }, []);

  const size = (): { w: number; h: number } => {
    const r = boxRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 1, h: r?.height ?? 1 };
  };
  const zoomBy = (factor: number): void => {
    const { w, h } = size();
    setView((v) => zoomAt(v, factor, w / 2, h / 2, w, h));
  };
  const clearHold = (): void => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
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

  const regionRect = (): { x: number; y: number; width: number; height: number } | null => {
    if (!region || !width || !height) return null;
    return regionFromDrag(
      region.x0,
      region.y0,
      region.x1,
      region.y1,
      view,
      boxSize.w,
      boxSize.h,
      width,
      height,
    );
  };

  const loupeStyle = (): CSSProperties | null => {
    if (!loupe || !width || !height) return null;
    const bg = loupeBackground({
      cursorX: loupe.x,
      cursorY: loupe.y,
      boxW: boxSize.w,
      boxH: boxSize.h,
      natW: width,
      natH: height,
      zoom: LOUPE_ZOOM,
      radius: LOUPE_RADIUS,
    });
    if (!bg) return null;
    return {
      left: loupe.x - LOUPE_RADIUS,
      top: loupe.y - LOUPE_RADIUS,
      width: LOUPE_RADIUS * 2,
      height: LOUPE_RADIUS * 2,
      backgroundImage: `url("${src}")`,
      backgroundRepeat: 'no-repeat',
      backgroundSize: `${String(bg.bgW)}px ${String(bg.bgH)}px`,
      backgroundPosition: `${String(bg.posX)}px ${String(bg.posY)}px`,
    };
  };

  const rect = regionRect();
  const regionBox = region
    ? {
        left: Math.min(region.x0, region.x1),
        top: Math.min(region.y0, region.y1),
        width: Math.abs(region.x1 - region.x0),
        height: Math.abs(region.y1 - region.y0),
      }
    : null;

  return (
    <div className="space-y-1">
      <div
        ref={boxRef}
        tabIndex={0}
        aria-label="이미지 보기 (← → 이전·다음, + - 확대, I 컬러 피커, 누르고 있으면 돋보기)"
        className={`relative h-[60vh] w-full select-none overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)] ${picking ? 'cursor-crosshair' : view.scale > 1 ? 'cursor-grab' : ''}`}
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
          const r = boxRef.current?.getBoundingClientRect();
          const x = e.clientX - (r?.left ?? 0);
          const y = e.clientY - (r?.top ?? 0);
          if (e.ctrlKey && onSaveRegion && !picking) {
            setRegion({ x0: x, y0: y, x1: x, y1: y });
            drag.current = null;
            return;
          }
          drag.current = { x: e.clientX, y: e.clientY, moved: false };
          if (!picking && width && height) {
            clearHold();
            holdTimer.current = setTimeout(() => {
              if (drag.current && !drag.current.moved) setLoupe({ x, y });
            }, 350);
          }
        }}
        onMouseMove={(e) => {
          const r = boxRef.current?.getBoundingClientRect();
          const x = e.clientX - (r?.left ?? 0);
          const y = e.clientY - (r?.top ?? 0);
          if (region) {
            setRegion((g) => (g ? { ...g, x1: x, y1: y } : g));
            return;
          }
          const d = drag.current;
          if (!d || picking) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) {
            d.moved = true;
            clearHold();
          }
          if (loupe) {
            setLoupe({ x, y });
            return;
          }
          if (view.scale <= 1) return;
          const { w, h } = size();
          d.x = e.clientX;
          d.y = e.clientY;
          setView((v) => panBy(v, dx, dy, w, h));
        }}
        onMouseUp={(e) => {
          clearHold();
          setLoupe(null);
          const d = drag.current;
          drag.current = null;
          if (region) return;
          if (picking && d && !d.moved) void doPick(e.clientX, e.clientY);
        }}
        onMouseLeave={() => {
          clearHold();
          setLoupe(null);
          drag.current = null;
        }}
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
        {regionBox && (
          <div
            data-testid="region-box"
            className="pointer-events-none absolute border-2 border-dashed border-white bg-white/10"
            style={{
              left: regionBox.left,
              top: regionBox.top,
              width: regionBox.width,
              height: regionBox.height,
            }}
          />
        )}
        {loupe && loupeStyle() && (
          <div
            data-testid="loupe"
            aria-hidden
            className="pointer-events-none absolute rounded-full border-2 border-white shadow-lg"
            style={loupeStyle() ?? undefined}
          />
        )}
      </div>
      {region && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-[var(--c-border)] p-2 text-xs">
          <span>영역 {rect ? `${String(rect.width)}×${String(rect.height)}` : '(이미지 밖)'}</span>
          <Button
            variant="primary"
            disabled={!rect || !onSaveRegion}
            onClick={() => {
              if (rect && onSaveRegion) onSaveRegion(rect);
              setRegion(null);
            }}
          >
            영역 저장 (원본 해상도, 새 파일)
          </Button>
          <Button onClick={() => setRegion(null)}>취소</Button>
        </div>
      )}
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
          {Math.round(view.scale * 100)}% · 휠 확대, 끌어 이동, 누르고 있으면 돋보기
          {onSaveRegion ? ', Ctrl+드래그로 영역 선택' : ''}
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
