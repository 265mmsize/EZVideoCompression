/**
 * 영상 편집 실시간 미리보기 (근사치).
 *
 * 원본 클립을 <video> 두 개로 번갈아 재생한다. 기준 시계는 벽시계이고, 영상 요소는 그 시계에 맞춰 움직인다.
 * 보이는 영상이 아직 준비되지 않았으면 시계를 멈추고, 다음 클립은 끝나기 전에 빈 요소에 미리 불러 둔다.
 * 배속·회전·반전·밝기·대비·채도는 CSS 로, 텍스트·워터마크는 겹쳐서, 전환은 불투명도로 흉내 낸다.
 * 손떨림 보정, 선명하게, 노이즈 제거, 닦기·밀기 같은 전환 모양은 반영하지 않는다. 결과는 내보내기에서 확인한다.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { resolveCanvas, type Canvas } from '../../shared/editCanvas';
import type { EditProject } from '../../shared/types/domain';
import { libraryApi } from '../library/libraryActions';
import { clipDur, layout } from './editOps';
import {
  clipGain,
  contentBox,
  cssFilter,
  layersAt,
  musicGain,
  musicTimeAt,
  needsSeek,
  preloadIndex,
  textStyle,
  textVisible,
  watermarkStyle,
} from './previewMath';

/** 다음 클립을 이 시간 전에 미리 불러 둔다 */
const PRELOAD_SEC = 1.5;
/** 부모에 재생 위치를 알리는 간격 */
const REPORT_MS = 100;
/** HTMLMediaElement.HAVE_CURRENT_DATA */
const HAVE_CURRENT_DATA = 2;

interface Slot {
  clipId: string | null;
  url: string | null;
  /** 메타데이터를 읽은 뒤 옮겨 갈 위치 */
  pendingSeek: number | null;
}

interface ViewLayer {
  slot: number;
  clipId: string;
  opacity: number;
  localSec: number;
  order: number;
}

export function TimelinePreview({
  project,
  startSec,
  onTime,
  onEnded,
  onError,
}: {
  project: EditProject;
  startSec: number;
  onTime: (t: number) => void;
  onEnded: (t: number) => void;
  onError: (message: string) => void;
}): ReactNode {
  const v0 = useRef<HTMLVideoElement>(null);
  const v1 = useRef<HTMLVideoElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
  const slots = useRef<Slot[]>([
    { clipId: null, url: null, pendingSeek: null },
    { clipId: null, url: null, pendingSeek: null },
  ]);
  const urls = useRef(new Map<string, string>());
  const latest = useRef({ project, onTime, onEnded, onError });
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<ViewLayer[]>([]);
  const [watermarkUrl, setWatermarkUrl] = useState<string | null>(null);

  // 최신 프로젝트와 콜백을 재생 루프에 넘긴다 (재생 중 편집도 반영된다)
  useEffect(() => {
    latest.current = { project, onTime, onEnded, onError };
  });

  const canvas = useMemo(() => resolveCanvas(project), [project]);
  const paths = useMemo(() => {
    const list = project.clips.map((c) => c.path);
    if (project.music) list.push(project.music.path);
    return [...new Set(list)];
  }, [project.clips, project.music]);
  const pathsKey = paths.join('\n');

  // 재생 주소를 미리 받는다. 하나라도 열 수 없으면 알리고 멈춘다.
  useEffect(() => {
    const live = { on: true };
    void (async () => {
      for (const p of paths) {
        if (urls.current.has(p)) continue;
        const u = await libraryApi.editMediaUrl(p);
        if (!live.on) return;
        if (!u) {
          latest.current.onError(`미리보기용 파일을 열 수 없습니다: ${p}`);
          return;
        }
        urls.current.set(p, u);
      }
      if (live.on) setReady(true);
    })();
    return () => {
      live.on = false;
    };
    // 경로 목록이 바뀔 때만 다시 받는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathsKey]);

  const watermarkPath = project.watermark?.path ?? null;
  useEffect(() => {
    if (!watermarkPath) return;
    let alive = true;
    void libraryApi.imageOpen(watermarkPath).then((info) => {
      if (alive && info) setWatermarkUrl(info.url);
    });
    return () => {
      alive = false;
    };
  }, [watermarkPath]);

  // 메타데이터를 읽으면 기다리던 위치로 옮기고, 재생할 수 없는 형식은 알린다
  useEffect(() => {
    const els = [v0.current, v1.current];
    const offs: (() => void)[] = [];
    els.forEach((el, si) => {
      if (!el) return;
      const onMeta = (): void => {
        const st = slots.current[si];
        if (st && st.pendingSeek !== null) {
          el.currentTime = st.pendingSeek;
          st.pendingSeek = null;
        }
      };
      const onErr = (): void => {
        const st = slots.current[si];
        const c = latest.current.project.clips.find((x) => x.id === st?.clipId);
        latest.current.onError(
          `${c?.fileName ?? '클립'}: 미리보기에서 재생할 수 없는 형식입니다. 내보내기에는 영향이 없습니다.`,
        );
      };
      el.addEventListener('loadedmetadata', onMeta);
      el.addEventListener('error', onErr);
      offs.push(() => {
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeEventListener('error', onErr);
      });
    });
    return () => {
      for (const off of offs) off();
    };
  }, []);

  // 재생 루프
  useEffect(() => {
    if (!ready) return;
    const els = [v0, v1];
    let raf = 0;
    let clock = startSec;
    let last = performance.now();
    let lastReport = 0;
    let lastViewKey = '';

    const load = (si: number, clipId: string, path: string, sourceSec: number): void => {
      const el = els[si]?.current;
      const st = slots.current[si];
      const url = urls.current.get(path);
      if (!el || !st || !url) return;
      st.clipId = clipId;
      if (st.url !== url) {
        st.url = url;
        st.pendingSeek = sourceSec;
        el.src = url;
        el.load();
      } else {
        el.currentTime = sourceSec;
      }
    };

    const stopAll = (): void => {
      for (const r of els) r.current?.pause();
      musicRef.current?.pause();
    };

    const tick = (now: number): void => {
      const { project: p, onTime, onEnded } = latest.current;
      const clips = p.clips;
      const { total } = layout(clips);
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;

      const layers = layersAt(clips, clock);
      if (layers.length === 0) {
        stopAll();
        onTime(Math.min(clock, total));
        onEnded(Math.min(clock, total));
        return;
      }

      // 필요한 클립: 보이는 클립 + 곧 이어질 클립
      const needed = layers.map((l) => l.index);
      const pre = preloadIndex(clips, clock, PRELOAD_SEC);
      if (pre !== null) needed.push(pre);
      const neededIds = needed.map((i) => clips[i]?.id).filter((x): x is string => !!x);

      // 이미 그 클립을 가진 요소는 그대로 두고, 나머지는 빈 요소에 싣는다
      const slotOf = new Map<string, number>();
      slots.current.forEach((st, si) => {
        if (st.clipId && neededIds.includes(st.clipId) && !slotOf.has(st.clipId))
          slotOf.set(st.clipId, si);
      });
      for (const i of needed) {
        const c = clips[i];
        if (!c || slotOf.has(c.id)) continue;
        const used = new Set(slotOf.values());
        const free = slots.current.findIndex((_, si) => !used.has(si));
        if (free < 0) continue;
        slotOf.set(c.id, free);
        const layer = layers.find((l) => l.index === i);
        load(free, c.id, c.path, layer ? layer.sourceSec : c.inSec);
      }

      // 보이는 클립을 시계에 맞춘다. 하나라도 준비가 덜 됐으면 시계를 멈춘다.
      let waiting = false;
      const active = new Set<number>();
      const nextView: ViewLayer[] = [];
      for (const [order, l] of layers.entries()) {
        const c = clips[l.index];
        const si = c ? slotOf.get(c.id) : undefined;
        const el = si !== undefined ? els[si]?.current : null;
        const st = si !== undefined ? slots.current[si] : undefined;
        if (!c || si === undefined || !el || !st) {
          waiting = true;
          continue;
        }
        active.add(si);
        nextView.push({ slot: si, clipId: c.id, opacity: l.opacity, localSec: l.localSec, order });
        if (st.pendingSeek !== null || el.readyState < HAVE_CURRENT_DATA || el.seeking) {
          waiting = true;
          continue;
        }
        el.playbackRate = c.speed;
        if (needsSeek(el.currentTime, l.sourceSec, c.speed)) el.currentTime = l.sourceSec;
        const gain = clipGain(c, p.music) * l.opacity;
        el.muted = gain <= 0;
        el.volume = Math.min(1, Math.max(0, gain));
        if (el.paused) void el.play().catch(() => undefined);
      }
      // 보이지 않는 요소(미리 불러 둔 다음 클립 포함)는 멈춰 둔다
      els.forEach((r, si) => {
        if (!active.has(si)) r.current?.pause();
      });
      if (waiting) for (const si of active) els[si]?.current?.pause();

      // 배경 음악
      const a = musicRef.current;
      const m = p.music;
      const murl = m ? urls.current.get(m.path) : undefined;
      if (a && m && murl) {
        if (a.dataset['src'] !== murl) {
          a.dataset['src'] = murl;
          a.src = murl;
        }
        const mt = musicTimeAt(m, clock);
        if (mt === null || waiting) {
          a.pause();
        } else {
          if (a.readyState >= HAVE_CURRENT_DATA && needsSeek(a.currentTime, mt, 1))
            a.currentTime = mt;
          a.volume = musicGain(m, clock, total);
          if (a.paused) void a.play().catch(() => undefined);
        }
      } else {
        a?.pause();
      }

      if (!waiting) clock += dt;

      // 화면 갱신은 바뀐 것이 있을 때만 (텍스트는 0.05초, 불투명도는 0.01 단위)
      const key = nextView
        .map(
          (v) => `${String(v.slot)}:${v.clipId}:${v.opacity.toFixed(2)}:${v.localSec.toFixed(2)}`,
        )
        .join('|');
      if (key !== lastViewKey) {
        lastViewKey = key;
        setView(nextView);
      }
      if (now - lastReport >= REPORT_MS) {
        lastReport = now;
        onTime(Math.min(clock, total));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      stopAll();
    };
  }, [ready, startSec]);

  // 끝날 때 디코더를 놓아 준다
  useEffect(() => {
    const els = [v0.current, v1.current];
    const music = musicRef.current;
    return () => {
      for (const el of els) {
        if (!el) continue;
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
      if (music) {
        music.pause();
        music.removeAttribute('src');
      }
    };
  }, []);

  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      style={{ containerType: 'size' }}
    >
      <div
        data-testid="timeline-preview"
        className="relative overflow-hidden bg-black"
        style={{
          aspectRatio: `${String(canvas.width)} / ${String(canvas.height)}`,
          width: `min(100cqw, calc(100cqh * ${String(canvas.width)} / ${String(canvas.height)}))`,
          containerType: 'size',
        }}
      >
        <LayerView videoRef={v0} slot={0} view={view} project={project} canvas={canvas} />
        <LayerView videoRef={v1} slot={1} view={view} project={project} canvas={canvas} />
        {project.watermark && watermarkUrl && (
          <img
            src={watermarkUrl}
            alt=""
            aria-hidden
            style={{ ...watermarkStyle(project.watermark, canvas), zIndex: 10 }}
          />
        )}
        <audio ref={musicRef} preload="auto" />
        {!ready && (
          <span className="absolute inset-0 flex items-center justify-center text-xs text-white/70">
            미리보기 준비 중…
          </span>
        )}
      </div>
    </div>
  );
}

/** 영상 요소 하나와 그 클립의 텍스트. 들어오는 클립이 위에 오도록 순서를 매긴다. */
function LayerView({
  videoRef,
  slot,
  view,
  project,
  canvas,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  slot: number;
  view: ViewLayer[];
  project: EditProject;
  canvas: Canvas;
}): ReactNode {
  const v = view.find((x) => x.slot === slot);
  const clip = v ? project.clips.find((c) => c.id === v.clipId) : undefined;
  const box = clip ? contentBox(clip, canvas) : null;
  return (
    <div
      className="absolute inset-0"
      style={{ opacity: v ? v.opacity : 0, zIndex: v ? v.order + 1 : 0 }}
    >
      <video
        ref={videoRef}
        preload="auto"
        playsInline
        className="absolute"
        style={
          box && clip
            ? {
                left: '50%',
                top: '50%',
                width: `${box.widthPct.toFixed(4)}%`,
                height: `${box.heightPct.toFixed(4)}%`,
                objectFit: 'fill',
                transform: box.transform,
                filter: cssFilter(clip.filters),
              }
            : { width: 0, height: 0 }
        }
      />
      {clip &&
        v &&
        clip.texts
          .filter((t) => textVisible(t, v.localSec, clipDur(clip)))
          .map((t) => (
            <span key={t.id} style={textStyle(t, canvas)}>
              {t.text}
            </span>
          ))}
    </div>
  );
}
