/**
 * 킹뷰 보기 화면: 1장·2장·웹툰 보기, 슬라이드쇼, 재생목록, 탐색기(썸네일) 모드,
 * 압축 파일(ZIP, CBZ) 안 이미지, 영역 저장.
 * 라이브러리 항목, 폴더 파일, 압축 파일 안 항목을 같은 방식으로 다룬다. 원본 파일은 읽기만 한다.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '../components/ui';
import { ZoomableImage } from '../library/PlayerTools';
import { libraryApi } from '../library/libraryActions';
import { DEFAULT_EDIT_OPS } from '../pages/ImageEditorPage';
import {
  addToPlaylist,
  buildSpreads,
  clampIndex,
  movePlaylistItem,
  nextWebtoonWidth,
  removeFromPlaylist,
  slideshowNext,
  SLIDESHOW_INTERVALS,
  spreadIndexOf,
  stepIndex,
  type ViewMode,
  type WebtoonWidth,
} from './viewerMath';
import { loadPlaylists, newPlaylist, savePlaylists, type Playlist } from './playlistStore';

export interface Loaded {
  url: string;
  width: number | null;
  height: number | null;
  path: string | null;
  label: string;
  itemId: string | null;
}

export interface ViewItem {
  key: string;
  label: string;
  itemId: string | null;
  load: () => Promise<Loaded | null>;
}

export interface ViewSeed {
  ids: string[];
  startId: string;
}

export type ViewSurface = 'viewer' | 'explorer';

export function fromLibraryIds(ids: string[]): ViewItem[] {
  return ids.map((id) => ({
    key: id,
    label: id.slice(0, 8),
    itemId: id,
    load: async () => {
      const it = await libraryApi.get(id);
      if (!it) return null;
      const src = await libraryApi.source({ kind: 'item', id });
      if (!src) return null;
      return {
        url: src.url,
        width: it.width,
        height: it.height,
        path: it.path,
        label: it.fileName,
        itemId: id,
      };
    },
  }));
}

export function fromPaths(paths: string[]): ViewItem[] {
  return paths.map((p) => ({
    key: p,
    label: baseName(p),
    itemId: null,
    load: async () => {
      const info = await libraryApi.imageOpen(p);
      if (!info) return null;
      return {
        url: info.url,
        width: info.width,
        height: info.height,
        path: info.path,
        label: info.fileName,
        itemId: null,
      };
    },
  }));
}

export function fromArchive(zip: string, names: string[]): ViewItem[] {
  return names.map((name) => ({
    key: `${zip}#${name}`,
    label: name,
    itemId: null,
    load: async () => {
      const r = await libraryApi.archiveOpen(zip, name);
      if (!r) return null;
      return { url: r.url, width: null, height: null, path: null, label: name, itemId: null };
    },
  }));
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function dirName(p: string): string {
  return p.replace(/[\\/][^\\/]*$/, '');
}

export function ViewerPage({
  seed,
  onExit,
}: {
  seed: ViewSeed | null;
  onExit?: () => void;
}): ReactNode {
  const rootRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<ViewItem[]>(() => (seed ? fromLibraryIds(seed.ids) : []));
  const [index, setIndex] = useState(() => {
    if (!seed) return 0;
    const i = seed.ids.indexOf(seed.startId);
    return i < 0 ? 0 : i;
  });
  const [surface, setSurface] = useState<ViewSurface>('viewer');
  const [mode, setMode] = useState<ViewMode>('single');
  const [coverSingle, setCoverSingle] = useState(true);
  const [rtl, setRtl] = useState(false);
  const [webtoonWidth, setWebtoonWidth] = useState<WebtoonWidth>(0);
  const [slideshow, setSlideshow] = useState(false);
  const [interval, setIntervalSec] = useState<number>(3);
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [panel, setPanel] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>(() => loadPlaylists());
  const [activeList, setActiveList] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const inflight = useRef(new Set<string>());

  const count = items.length;
  const spreads = useMemo(
    () => buildSpreads(count, { twoUp: mode === 'spread', coverSingle, rtl }),
    [count, mode, coverSingle, rtl],
  );
  const cur = items[clampIndex(index, count)];
  const curLoaded = cur ? loaded[cur.key] : undefined;

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  function ensure(i: number): void {
    const it = items[i];
    if (!it || loaded[it.key] || inflight.current.has(it.key)) return;
    inflight.current.add(it.key);
    void it.load().then((r) => {
      inflight.current.delete(it.key);
      if (r) setLoaded((prev) => ({ ...prev, [it.key]: r }));
    });
  }

  // 보이는 장만 읽는다 (웹툰·탐색기는 화면에 들어올 때 각각 읽는다)
  useEffect(() => {
    if (surface !== 'viewer' || mode === 'webtoon' || count === 0) return;
    const want = new Set<number>();
    if (mode === 'spread')
      for (const p of spreads[spreadIndexOf(spreads, index)] ?? []) want.add(p);
    else want.add(clampIndex(index, count));
    if (index + 1 < count) want.add(index + 1);
    for (const i of want) ensure(i);
    // ensure 는 현재 항목 목록에 의존하므로 아래 의존성에 items 를 둔다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, index, mode, spreads, surface]);

  // 슬라이드쇼: 설정한 간격마다 다음 장 (2장 보기에서는 다음 펼침면)
  useEffect(() => {
    if (!slideshow || count === 0) return;
    const t = setInterval(() => {
      setIndex((i) => {
        if (mode === 'spread' && spreads.length > 0) {
          const s = spreadIndexOf(spreads, i);
          const next = spreads[(s + 1) % spreads.length] ?? [];
          return next.length > 0 ? Math.min(...next) : i;
        }
        return slideshowNext(i, count);
      });
    }, interval * 1000);
    return () => clearInterval(t);
  }, [slideshow, interval, count, mode, spreads]);

  const step = (dir: 1 | -1): void => {
    if (mode === 'spread' && spreads.length > 0) {
      const s = spreadIndexOf(spreads, index);
      const next = spreads[clampIndex(s + dir, spreads.length)];
      if (next && next.length > 0)
        setIndex(dir > 0 ? Math.max(...next) + 1 : Math.min(...next) - 1);
      return;
    }
    setIndex((i) => stepIndex(i, count, dir));
  };

  const goTo = (i: number): void => {
    setIndex(clampIndex(i, count));
    setSurface('viewer');
  };

  const openItems = (list: ViewItem[], start = 0): void => {
    setLoaded({});
    setItems(list);
    setIndex(clampIndex(start, list.length));
    setSlideshow(false);
    setSurface('viewer');
  };

  const openFile = async (): Promise<void> => {
    const res = await libraryApi.viewerPickFile();
    if (!res) return;
    const p = res.path;
    if (/\.(zip|cbz)$/i.test(p)) {
      const entries = await libraryApi.archiveList(p);
      if (!entries || entries.length === 0) {
        setNotice('압축 파일 안에 볼 수 있는 이미지가 없습니다.');
        return;
      }
      openItems(
        fromArchive(
          p,
          entries.map((e) => e.name),
        ),
      );
      return;
    }
    const listing = await libraryApi.viewerListFolder(dirName(p));
    const paths = listing?.paths ?? [p];
    openItems(fromPaths(paths), Math.max(0, paths.indexOf(p)));
  };

  const openFolder = async (): Promise<void> => {
    const res = await libraryApi.viewerPickFolder();
    if (!res) return;
    const listing = await libraryApi.viewerListFolder(res.path);
    if (!listing || listing.paths.length === 0) {
      setNotice('폴더 안에 이미지가 없습니다.');
      return;
    }
    openItems(fromPaths(listing.paths));
  };

  const saveRegion = async (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }): Promise<void> => {
    if (!curLoaded?.path) {
      setNotice('파일 경로가 없어 영역을 저장할 수 없습니다 (압축 안 이미지는 제외).');
      return;
    }
    const r = await libraryApi.imageExport({
      path: curLoaded.path,
      ops: { ...DEFAULT_EDIT_OPS, crop: rect },
      format: 'keep',
      quality: 95,
      target: { kind: 'suffix', suffix: '-crop' },
    });
    if (r) setNotice(`영역 저장됨: ${r.outputPath} (${String(r.width)}×${String(r.height)})`);
  };

  const updateLists = (next: Playlist[]): void => {
    setPlaylists(next);
    savePlaylists(next);
  };

  const activePlaylist = playlists.find((p) => p.id === activeList) ?? null;
  const labelOf = (id: string): string => {
    const hit = Object.values(loaded).find((l) => l.itemId === id);
    return hit?.label ?? id.slice(0, 8);
  };
  const editActive = (fn: (ids: string[]) => string[]): void => {
    if (!activePlaylist) return;
    updateLists(
      playlists.map((p) => (p.id === activePlaylist.id ? { ...p, itemIds: fn(p.itemIds) } : p)),
    );
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col gap-2 p-3 text-sm outline-none"
      onKeyDown={(e) => {
        if (e.defaultPrevented) return;
        const tag = (e.target as HTMLElement).tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
          e.preventDefault();
          setSurface((s) => (s === 'viewer' ? 'explorer' : 'viewer'));
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === '0') {
          e.preventDefault();
          setSlideshow((v) => !v);
          return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'Escape') {
          onExit?.();
          return;
        }
        if (surface === 'explorer') return;
        if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
          e.preventDefault();
          step(-1);
        } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
          e.preventDefault();
          step(1);
        } else if (e.key === 'Home') {
          setIndex(0);
        } else if (e.key === 'End') {
          setIndex(Math.max(0, count - 1));
        } else if (e.key === 'w' || e.key === 'W') {
          setMode((m) => (m === 'webtoon' ? 'single' : 'webtoon'));
        } else if (e.key === '1') {
          setMode('single');
        } else if (e.key === '2') {
          setMode('spread');
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-1">
        <Button variant="primary" onClick={() => void openFile()}>
          파일 열기 (이미지·ZIP·CBZ)
        </Button>
        <Button onClick={() => void openFolder()}>폴더 열기</Button>
        <span className="mx-1 h-5 w-px bg-[var(--c-border)]" />
        <Button
          variant={surface === 'explorer' ? 'primary' : 'ghost'}
          onClick={() => setSurface((s) => (s === 'viewer' ? 'explorer' : 'viewer'))}
        >
          {surface === 'explorer' ? '뷰어로 돌아가기 (Ctrl+M)' : '탐색기 보기 (Ctrl+M)'}
        </Button>
        {(
          [
            ['single', '1장 (1)'],
            ['spread', '2장 (2)'],
            ['webtoon', '웹툰 (W)'],
          ] as const
        ).map(([m, label]) => (
          <Button
            key={m}
            variant={mode === m && surface === 'viewer' ? 'primary' : 'ghost'}
            onClick={() => {
              setMode(m);
              setSurface('viewer');
            }}
          >
            {label}
          </Button>
        ))}
        {mode === 'spread' && (
          <>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={coverSingle}
                onChange={(e) => setCoverSingle(e.target.checked)}
              />
              표지 단독
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={rtl} onChange={(e) => setRtl(e.target.checked)} />
              오른쪽에서 왼쪽
            </label>
          </>
        )}
        {mode === 'webtoon' && (
          <Button onClick={() => setWebtoonWidth((w) => nextWebtoonWidth(w))} aria-label="웹툰 폭">
            폭: {webtoonWidth === 0 ? '100%' : `${String(webtoonWidth)}px`}
          </Button>
        )}
        <span className="mx-1 h-5 w-px bg-[var(--c-border)]" />
        <Button variant={slideshow ? 'primary' : 'ghost'} onClick={() => setSlideshow((v) => !v)}>
          {slideshow ? '슬라이드쇼 정지 (Ctrl+0)' : '슬라이드쇼 (Ctrl+0)'}
        </Button>
        <select
          aria-label="슬라이드쇼 간격"
          className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-0.5 text-xs"
          value={String(interval)}
          onChange={(e) => setIntervalSec(Number(e.target.value))}
        >
          {SLIDESHOW_INTERVALS.map((n) => (
            <option key={n} value={String(n)}>
              {n}초
            </option>
          ))}
        </select>
        <Button variant={panel ? 'primary' : 'ghost'} onClick={() => setPanel((v) => !v)}>
          재생목록
        </Button>
        {onExit && (
          <Button className="ml-auto" onClick={onExit}>
            닫기 (Esc)
          </Button>
        )}
      </div>

      {count > 0 && (
        <div className="text-xs text-[var(--c-muted)]">
          {String(index + 1)} / {String(count)} · {cur?.label ?? ''}
          {curLoaded?.width && curLoaded.height
            ? ` · ${String(curLoaded.width)}×${String(curLoaded.height)}`
            : ''}
        </div>
      )}
      {notice && (
        <div role="status" className="rounded border border-[var(--c-border)] p-2 text-xs">
          {notice}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-2">
        <div className="min-w-0 flex-1 overflow-auto">
          {count === 0 && (
            <p className="text-[var(--c-muted)]">
              이미지, 폴더, 또는 ZIP·CBZ 압축 파일을 여세요. 라이브러리에서 이미지를 고르고 Ctrl+M
              을 누르면 뷰어로 열립니다.
            </p>
          )}

          {count > 0 && surface === 'explorer' && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
              {items.map((it, i) => (
                <button
                  key={it.key}
                  type="button"
                  onClick={() => goTo(i)}
                  aria-current={i === index ? 'true' : undefined}
                  className={`flex flex-col gap-1 rounded border p-1 text-left ${i === index ? 'border-[var(--c-accent)]' : 'border-[var(--c-border)]'}`}
                >
                  <LazyImage
                    label={it.label}
                    url={loaded[it.key]?.url ?? null}
                    placeholderClass="h-28 w-full"
                    imgClass="h-28 w-full object-cover"
                    onVisible={() => ensure(i)}
                  />
                  <span className="truncate text-xs">
                    {String(i + 1)}. {it.label}
                  </span>
                </button>
              ))}
            </div>
          )}

          {count > 0 &&
            surface === 'viewer' &&
            mode === 'single' &&
            cur &&
            !slideshow &&
            (curLoaded ? (
              <ZoomableImage
                key={cur.key}
                src={curLoaded.url}
                alt={curLoaded.label}
                itemId={curLoaded.itemId}
                width={curLoaded.width}
                height={curLoaded.height}
                onStep={step}
                onSaveRegion={curLoaded.path ? (r) => void saveRegion(r) : undefined}
              />
            ) : (
              <p className="p-4 text-[var(--c-muted)]">불러오는 중…</p>
            ))}

          {count > 0 && surface === 'viewer' && mode === 'single' && cur && slideshow && (
            <SlideshowFrame url={curLoaded?.url ?? null} alt={curLoaded?.label ?? ''} />
          )}

          {count > 0 && surface === 'viewer' && mode === 'spread' && (
            <div className="flex h-[70vh] items-center justify-center gap-1 bg-black">
              {(spreads[spreadIndexOf(spreads, index)] ?? []).map((p) => {
                const it = items[p];
                const l = it ? loaded[it.key] : undefined;
                return l ? (
                  <img
                    key={String(p)}
                    src={l.url}
                    alt={l.label}
                    className="h-full min-w-0 flex-1 object-contain"
                  />
                ) : (
                  <div key={String(p)} className="flex-1 text-center text-[var(--c-muted)]">
                    불러오는 중…
                  </div>
                );
              })}
            </div>
          )}

          {count > 0 && surface === 'viewer' && mode === 'webtoon' && (
            <div className="mx-auto flex flex-col items-center bg-black">
              {items.map((it, i) => (
                <LazyImage
                  key={it.key}
                  label={it.label}
                  url={loaded[it.key]?.url ?? null}
                  placeholderClass="h-64 w-full"
                  imgClass="block h-auto w-full"
                  style={{
                    width: webtoonWidth === 0 ? '100%' : `${String(webtoonWidth)}px`,
                    maxWidth: '100%',
                  }}
                  onVisible={() => ensure(i)}
                />
              ))}
            </div>
          )}
        </div>

        {panel && (
          <aside
            className="w-72 shrink-0 space-y-2 overflow-auto rounded border border-[var(--c-border)] p-2 text-xs"
            aria-label="재생목록"
          >
            <div className="flex gap-1">
              <input
                aria-label="새 재생목록 이름"
                className="min-w-0 flex-1 rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="새 목록 이름"
              />
              <Button
                onClick={() => {
                  const p = newPlaylist(newName);
                  updateLists([...playlists, p]);
                  setActiveList(p.id);
                  setNewName('');
                }}
              >
                만들기
              </Button>
            </div>
            {playlists.length === 0 && (
              <p className="text-[var(--c-muted)]">재생목록이 없습니다.</p>
            )}
            <ul className="space-y-1">
              {playlists.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={`w-full rounded px-2 py-1 text-left ${activeList === p.id ? 'bg-[var(--c-accent)] text-[var(--c-accent-text)]' : 'hover:bg-[var(--c-surface-2)]'}`}
                    onClick={() => setActiveList(p.id)}
                  >
                    {p.name} ({p.itemIds.length})
                  </button>
                </li>
              ))}
            </ul>
            {activePlaylist && (
              <div className="space-y-1 border-t border-[var(--c-border)] pt-2">
                <div className="flex flex-wrap gap-1">
                  <Button
                    disabled={activePlaylist.itemIds.length === 0}
                    onClick={() => openItems(fromLibraryIds(activePlaylist.itemIds))}
                  >
                    이 목록 보기
                  </Button>
                  <Button
                    disabled={activePlaylist.itemIds.length === 0}
                    onClick={() => {
                      openItems(fromLibraryIds(activePlaylist.itemIds));
                      setSlideshow(true);
                    }}
                  >
                    슬라이드쇼
                  </Button>
                  <Button
                    disabled={!cur?.itemId}
                    onClick={() => editActive((ids) => addToPlaylist(ids, cur?.itemId ?? ''))}
                  >
                    현재 이미지 추가
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      updateLists(playlists.filter((p) => p.id !== activePlaylist.id));
                      setActiveList(null);
                    }}
                  >
                    목록 삭제
                  </Button>
                </div>
                {activePlaylist.itemIds.map((id, i) => (
                  <div key={`${id}-${String(i)}`} className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate">{labelOf(id)}</span>
                    <Button
                      aria-label="위로"
                      onClick={() => editActive((ids) => movePlaylistItem(ids, i, -1))}
                    >
                      ↑
                    </Button>
                    <Button
                      aria-label="아래로"
                      onClick={() => editActive((ids) => movePlaylistItem(ids, i, 1))}
                    >
                      ↓
                    </Button>
                    <Button
                      variant="danger"
                      aria-label="목록에서 제거"
                      onClick={() => editActive((ids) => removeFromPlaylist(ids, i))}
                    >
                      ×
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

/** 슬라이드쇼 화면: 같은 이미지를 흐리게 배경으로 깔고, 가운데에 원래 비율로 보여 준다 */
function SlideshowFrame({ url, alt }: { url: string | null; alt: string }): ReactNode {
  if (!url) return <p className="p-4 text-[var(--c-muted)]">불러오는 중…</p>;
  return (
    <div className="relative h-[75vh] w-full overflow-hidden bg-black">
      <img
        src={url}
        alt=""
        aria-hidden
        className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl"
      />
      <img src={url} alt={alt} className="absolute inset-0 h-full w-full object-contain" />
    </div>
  );
}

/** 화면에 들어오기 전에는 자리만 차지하고, 들어오면 한 번만 읽는다 (웹툰·탐색기 공용) */
function LazyImage({
  label,
  url,
  placeholderClass,
  imgClass,
  style,
  onVisible,
}: {
  label: string;
  url: string | null;
  placeholderClass: string;
  imgClass: string;
  style?: CSSProperties;
  onVisible: () => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || url) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onVisible();
          io.disconnect();
        }
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
    // 읽기 요청은 한 번만 보내면 된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  if (!url) {
    return (
      <div
        ref={ref}
        className={`flex items-center justify-center bg-[var(--c-surface-2)] text-xs text-[var(--c-muted)] ${placeholderClass}`}
        style={style}
      >
        {label}
      </div>
    );
  }
  return <img src={url} alt={label} loading="lazy" className={imgClass} style={style} />;
}
