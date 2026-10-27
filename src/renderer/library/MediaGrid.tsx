import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { LibraryItem } from '../../shared/types/domain';
import { formatBytes, formatDuration } from '../format';
import { LABEL_COLORS, libraryApi } from './libraryActions';

const CARD_W = 208;
const CARD_H = 196;
const GAP = 8;
const OVERSCAN_ROWS = 2;

/** 썸네일·스크럽 URL 은 화면 수명 동안 기억한다 (같은 항목은 같은 URL) */
const thumbCache = new Map<string, string | null>();
const scrubCache = new Map<string, { urls: string[]; timesSec: number[] }>();

export function invalidateThumbCaches(): void {
  thumbCache.clear();
  scrubCache.clear();
}

/**
 * 가상 스크롤 그리드. 보이는 행만 렌더링해 수만 개 항목도 다룰 수 있다.
 * 끝에 가까워지면 onNeedMore 로 다음 페이지를 요청한다.
 */
export function MediaGrid({
  items,
  total,
  selectedIds,
  onSelect,
  onNeedMore,
  view,
}: {
  items: LibraryItem[];
  total: number;
  selectedIds: Set<string>;
  onSelect: (id: string, multi: boolean) => void;
  onNeedMore: () => void;
  view: 'grid' | 'list';
}): ReactNode {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setHeight(el.clientHeight);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const cols = view === 'grid' ? Math.max(1, Math.floor((width - GAP) / (CARD_W + GAP))) : 1;
  const rowH = view === 'grid' ? CARD_H + GAP : 44;
  const rows = Math.ceil(items.length / cols);
  const first = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN_ROWS);
  const last = Math.min(rows, Math.ceil((scrollTop + height) / rowH) + OVERSCAN_ROWS);

  useEffect(() => {
    if (items.length < total && last >= rows - 1) onNeedMore();
  }, [last, rows, items.length, total, onNeedMore]);

  const visible: { item: LibraryItem; row: number; col: number }[] = [];
  for (let r = first; r < last; r++) {
    for (let c = 0; c < cols; c++) {
      const it = items[r * cols + c];
      if (it) visible.push({ item: it, row: r, col: c });
    }
  }

  return (
    <div
      ref={scroller}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="relative h-full overflow-auto rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)]"
      role="listbox"
      aria-label="미디어 항목"
      aria-multiselectable="true"
    >
      {items.length === 0 && (
        <div className="p-10 text-center text-sm text-[var(--c-muted)]">
          항목이 없습니다. 폴더를 등록하거나 필터를 바꾸세요.
        </div>
      )}
      <div style={{ height: rows * rowH + GAP, position: 'relative' }}>
        {visible.map(({ item, row, col }) =>
          view === 'grid' ? (
            <div
              key={item.id}
              style={{
                position: 'absolute',
                top: row * rowH + GAP,
                left: col * (CARD_W + GAP) + GAP,
                width: CARD_W,
                height: CARD_H,
              }}
            >
              <MediaCard item={item} selected={selectedIds.has(item.id)} onSelect={onSelect} />
            </div>
          ) : (
            <div
              key={item.id}
              style={{ position: 'absolute', top: row * rowH, left: 0, right: 0, height: rowH }}
            >
              <MediaRow item={item} selected={selectedIds.has(item.id)} onSelect={onSelect} />
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function useThumb(item: LibraryItem): string | null {
  const [url, setUrl] = useState<string | null>(thumbCache.get(item.id) ?? null);
  useEffect(() => {
    let alive = true;
    if (thumbCache.has(item.id)) return; // 초기 상태가 이미 캐시 값이다
    void libraryApi.thumb(item.id).then((u) => {
      thumbCache.set(item.id, u);
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [item.id]);
  return url;
}

export function MediaCard({
  item,
  selected,
  onSelect,
}: {
  item: LibraryItem;
  selected: boolean;
  onSelect: (id: string, multi: boolean) => void;
}): ReactNode {
  const thumb = useThumb(item);
  const [scrub, setScrub] = useState<{ urls: string[]; timesSec: number[] } | null>(
    scrubCache.get(item.id) ?? null,
  );
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const onEnter = (): void => {
    if (item.kind !== 'video' || scrub) return;
    void libraryApi.scrub(item.id).then((s) => {
      scrubCache.set(item.id, s);
      setScrub(s);
    });
  };
  const onMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!scrub || scrub.urls.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(0.999, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHoverIndex(Math.floor(ratio * scrub.urls.length));
  };
  const shown = hoverIndex !== null && scrub ? (scrub.urls[hoverIndex] ?? thumb) : thumb;
  const hoverTime = hoverIndex !== null && scrub ? scrub.timesSec[hoverIndex] : undefined;

  return (
    <div
      role="option"
      aria-label={item.fileName}
      aria-selected={selected}
      tabIndex={0}
      onClick={(e) => onSelect(item.id, e.ctrlKey || e.metaKey || e.shiftKey)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(item.id, e.ctrlKey || e.metaKey);
        }
      }}
      className={`flex h-full cursor-pointer flex-col overflow-hidden rounded-md border ${selected ? 'border-[var(--c-accent)] ring-2 ring-[var(--c-accent)]' : 'border-[var(--c-border)]'} bg-[var(--c-surface)]`}
      title={item.path}
    >
      <div
        className="relative flex h-[117px] items-center justify-center bg-black"
        onMouseEnter={onEnter}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {shown ? (
          <img src={shown} alt="" className="h-full w-full object-contain" draggable={false} />
        ) : (
          <span className="text-xs text-white/60">
            {item.missing ? '파일 없음' : item.errorCode ? '분석 실패' : '썸네일 생성 중'}
          </span>
        )}
        {item.kind === 'video' && (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[11px] text-white">
            {hoverTime !== undefined
              ? `${hoverTime.toFixed(1)}초`
              : formatDuration(item.durationSec)}
          </span>
        )}
        {item.label && (
          <span
            className="absolute left-1 top-1 h-3 w-3 rounded-full"
            style={{ background: LABEL_COLORS[item.label] }}
            aria-label={`라벨 ${item.label}`}
          />
        )}
        {item.compression && (
          <span className="absolute right-1 top-1 rounded bg-[var(--c-accent)] px-1 text-[10px] text-[var(--c-accent-text)]">
            {item.compression.status === 'completed' ? '압축됨' : '작업 있음'}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col justify-between p-1.5">
        <div className="truncate text-xs font-medium" title={item.fileName}>
          {item.fileName}
        </div>
        <div className="flex items-center justify-between text-[11px] text-[var(--c-muted)]">
          <span>
            {formatBytes(item.sizeBytes)}
            {item.width && item.height ? ` · ${String(item.width)}×${String(item.height)}` : ''}
          </span>
          <span aria-label={`평점 ${String(item.rating)}`}>{'★'.repeat(item.rating)}</span>
        </div>
      </div>
    </div>
  );
}

function MediaRow({
  item,
  selected,
  onSelect,
}: {
  item: LibraryItem;
  selected: boolean;
  onSelect: (id: string, multi: boolean) => void;
}): ReactNode {
  return (
    <div
      role="option"
      aria-label={item.fileName}
      aria-selected={selected}
      tabIndex={0}
      onClick={(e) => onSelect(item.id, e.ctrlKey || e.metaKey || e.shiftKey)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(item.id, e.ctrlKey || e.metaKey);
        }
      }}
      className={`grid h-full cursor-pointer grid-cols-[1fr_90px_80px_110px_60px_70px] items-center gap-2 border-b border-[var(--c-border)] px-3 text-xs ${selected ? 'bg-[var(--c-surface-2)]' : ''}`}
      title={item.path}
    >
      <span className="truncate font-medium">
        {item.label && (
          <span
            className="mr-1 inline-block h-2.5 w-2.5 rounded-full align-middle"
            style={{ background: LABEL_COLORS[item.label] }}
          />
        )}
        {item.fileName}
      </span>
      <span>{item.kind === 'video' ? '영상' : item.kind === 'image' ? '이미지' : '기타'}</span>
      <span>{formatBytes(item.sizeBytes)}</span>
      <span>
        {item.width && item.height ? `${String(item.width)}×${String(item.height)}` : '-'}
        {item.videoCodec ? ` ${item.videoCodec}` : ''}
      </span>
      <span>{item.kind === 'video' ? formatDuration(item.durationSec) : '-'}</span>
      <span>{'★'.repeat(item.rating)}</span>
    </div>
  );
}
