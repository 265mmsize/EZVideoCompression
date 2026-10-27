import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  DuplicateGroup,
  LibraryItem,
  LibraryQuery,
  LibraryRoot,
  LibraryTreeNode,
  MediaLabel,
} from '../../shared/types/domain';
import { MEDIA_LABELS } from '../../shared/types/domain';
import { useAppStore } from '../hooks/useAppStore';
import { formatBytes, formatDuration } from '../format';
import { Button, ProgressBar } from '../components/ui';
import { MediaGrid, invalidateThumbCaches } from './MediaGrid';
import { MediaDetail } from './MediaDetail';
import { LABEL_COLORS, LABEL_NAMES, libraryApi } from './libraryActions';

const PAGE = 300;

const DEFAULT_QUERY: LibraryQuery = {
  rootId: null,
  dir: null,
  kinds: [],
  search: '',
  minRating: 0,
  label: null,
  tags: [],
  compressed: 'any',
  includeMissing: false,
  sort: 'name',
  order: 'asc',
  limit: PAGE,
  offset: 0,
};

export function LibraryPage({ onCompare }: { onCompare: (jobId: string) => void }): ReactNode {
  const { indexing, settings } = useAppStore();
  const [roots, setRoots] = useState<LibraryRoot[]>([]);
  const [trees, setTrees] = useState<Record<string, LibraryTreeNode>>({});
  const [query, setQuery] = useState<LibraryQuery>(DEFAULT_QUERY);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [tags, setTags] = useState<{ name: string; count: number }[]>([]);
  const [dupes, setDupes] = useState<DuplicateGroup[] | null>(null);
  const [includeSub, setIncludeSub] = useState<boolean>(settings?.includeSubfoldersDefault ?? true);
  const loadingRef = useRef(false);
  const wasIndexing = useRef(false);

  const loadRoots = useCallback(async () => {
    const r = await libraryApi.listRoots();
    if (!r) return;
    setRoots(r);
    const t: Record<string, LibraryTreeNode> = {};
    for (const root of r) {
      const tree = await libraryApi.tree(root.id);
      if (tree) t[root.id] = tree;
    }
    setTrees(t);
    const tg = await libraryApi.tags();
    if (tg) setTags(tg);
  }, []);

  const load = useCallback(async (q: LibraryQuery, append: boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const res = await libraryApi.query(q);
      if (!res) return;
      setTotal(res.total);
      setItems((prev) => (append ? [...prev, ...res.items] : res.items));
      if (!append) setSelected(new Set());
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    // 초기 조회는 외부 시스템(IPC) 호출이다. 결과 반영은 비동기 콜백에서 이뤄진다.
    queueMicrotask(() => void loadRoots());
  }, [loadRoots]);

  useEffect(() => {
    void load({ ...query, offset: 0 }, false);
  }, [query, load]);

  // 인덱싱이 끝나면 목록·트리를 새로 읽는다
  useEffect(() => {
    if (wasIndexing.current && !indexing.running) {
      invalidateThumbCaches();
      void loadRoots();
      void load({ ...query, offset: 0 }, false);
    }
    wasIndexing.current = indexing.running;
  }, [indexing.running, loadRoots, load, query]);

  const needMore = useCallback(() => {
    if (items.length >= total) return;
    void load({ ...query, offset: items.length }, true);
  }, [items.length, total, query, load]);

  const onSelect = (id: string, multi: boolean): void => {
    setSelected((prev) => {
      const next = new Set(multi ? prev : []);
      if (multi && prev.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedItem = useMemo(() => {
    if (selected.size !== 1) return null;
    const id = [...selected][0];
    return items.find((i) => i.id === id) ?? null;
  }, [selected, items]);

  const patchItem = (it: LibraryItem): void =>
    setItems((prev) => prev.map((p) => (p.id === it.id ? it : p)));

  const addRoot = async (): Promise<void> => {
    const r = await libraryApi.addRoot(includeSub);
    if (r) await loadRoots();
  };

  const removeRoot = async (id: string): Promise<void> => {
    if (
      !window.confirm(
        '이 폴더의 등록을 해제합니다. 파일은 삭제되지 않으며 앱의 항목·평점·태그 기록만 지워집니다. 계속할까요?',
      )
    )
      return;
    await libraryApi.removeRoot(id);
    await loadRoots();
    setQuery((q) => (q.rootId === id ? { ...q, rootId: null, dir: null } : { ...q }));
  };

  const findDuplicates = async (): Promise<void> => {
    const g = await libraryApi.duplicates();
    if (g) setDupes(g);
  };

  return (
    <div className="flex h-full gap-3 p-3">
      {/* 왼쪽: 폴더 */}
      <nav
        aria-label="라이브러리 폴더"
        className="flex w-[260px] shrink-0 flex-col gap-2 overflow-y-auto rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-2"
      >
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="primary" onClick={() => void addRoot()}>
            폴더 등록
          </Button>
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={includeSub}
              onChange={(e) => setIncludeSub(e.target.checked)}
            />{' '}
            하위 폴더 포함
          </label>
        </div>
        <button
          type="button"
          onClick={() => setQuery((q) => ({ ...q, rootId: null, dir: null }))}
          className={`rounded px-2 py-1 text-left text-sm ${query.rootId === null ? 'bg-[var(--c-surface-2)] font-semibold' : ''}`}
        >
          전체 ({roots.reduce((a, r) => a + r.itemCount, 0)})
        </button>
        {roots.map((root) => (
          <div key={root.id} className="text-sm">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setQuery((q) => ({ ...q, rootId: root.id, dir: null }))}
                className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-left ${query.rootId === root.id && query.dir === null ? 'bg-[var(--c-surface-2)] font-semibold' : ''}`}
                title={root.path}
              >
                {trees[root.id]?.name ?? root.path} ({root.itemCount})
              </button>
              <Button
                onClick={() => void libraryApi.reindex(root.id)}
                aria-label={`${root.path} 다시 인덱싱`}
                disabled={indexing.running}
              >
                ↻
              </Button>
              <Button
                onClick={() => void removeRoot(root.id)}
                aria-label={`${root.path} 등록 해제`}
              >
                ×
              </Button>
            </div>
            {trees[root.id] && (
              <TreeChildren
                node={trees[root.id] as LibraryTreeNode}
                depth={1}
                current={query.dir}
                onPick={(dir) => setQuery((q) => ({ ...q, rootId: root.id, dir }))}
              />
            )}
          </div>
        ))}
        {indexing.running && (
          <div className="mt-auto space-y-1 text-xs">
            <ProgressBar
              ratio={indexing.total > 0 ? indexing.processed / indexing.total : null}
              label="인덱싱 진행률"
            />
            <p className="truncate text-[var(--c-muted)]" title={indexing.currentFile ?? ''}>
              인덱싱 {indexing.processed}/{indexing.total}
            </p>
            <Button onClick={() => void libraryApi.cancelIndexing()}>인덱싱 취소</Button>
          </div>
        )}
        {indexing.lastError && (
          <p className="text-xs text-[var(--c-danger)]">{indexing.lastError}</p>
        )}
      </nav>

      {/* 가운데: 필터 + 그리드 */}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <FilterBar query={query} onChange={setQuery} tags={tags} view={view} onView={setView} />
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--c-muted)]">
          <span>
            {total}개 중 {items.length}개 표시
            {selected.size > 0 ? ` · ${String(selected.size)}개 선택` : ''}
          </span>
          <Button
            disabled={selected.size === 0}
            onClick={() => void libraryApi.enqueue([...selected])}
          >
            선택 항목 압축 대기열에 추가
          </Button>
          <Button onClick={() => setSelected(new Set(items.map((i) => i.id)))}>모두 선택</Button>
          <Button onClick={() => void findDuplicates()}>중복 후보 찾기</Button>
        </div>
        {dupes && (
          <DuplicatesPanel
            groups={dupes}
            onClose={() => setDupes(null)}
            onPick={(id) => setSelected(new Set([id]))}
          />
        )}
        <div className="min-h-0 flex-1">
          <MediaGrid
            items={items}
            total={total}
            selectedIds={selected}
            onSelect={onSelect}
            onNeedMore={needMore}
            view={view}
          />
        </div>
      </div>

      {selectedItem && (
        <MediaDetail
          key={selectedItem.id}
          item={selectedItem}
          onChanged={patchItem}
          onClose={() => setSelected(new Set())}
          onCompare={onCompare}
        />
      )}
    </div>
  );
}

function TreeChildren({
  node,
  depth,
  current,
  onPick,
}: {
  node: LibraryTreeNode;
  depth: number;
  current: string | null;
  onPick: (dir: string) => void;
}): ReactNode {
  if (node.children.length === 0) return null;
  return (
    <ul className="ml-2 border-l border-[var(--c-border)] pl-1">
      {node.children.map((c) => (
        <li key={c.path}>
          <button
            type="button"
            onClick={() => onPick(c.path)}
            className={`w-full truncate rounded px-2 py-0.5 text-left text-xs ${current === c.path ? 'bg-[var(--c-surface-2)] font-semibold' : ''}`}
            title={c.path}
          >
            {c.name} ({c.itemCount})
          </button>
          {depth < 6 && (
            <TreeChildren node={c} depth={depth + 1} current={current} onPick={onPick} />
          )}
        </li>
      ))}
    </ul>
  );
}

function FilterBar({
  query,
  onChange,
  tags,
  view,
  onView,
}: {
  query: LibraryQuery;
  onChange: (q: LibraryQuery) => void;
  tags: { name: string; count: number }[];
  view: 'grid' | 'list';
  onView: (v: 'grid' | 'list') => void;
}): ReactNode {
  const [search, setSearch] = useState(query.search);
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== query.search) onChange({ ...query, search });
    }, 250);
    return () => clearTimeout(t);
  }, [search, query, onChange]);
  const kind = query.kinds.length === 1 ? query.kinds[0] : 'all';
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <input
        className="w-48 rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
        placeholder="파일명 검색"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="파일명 검색"
      />
      <select
        className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
        value={kind}
        onChange={(e) =>
          onChange({
            ...query,
            kinds: e.target.value === 'all' ? [] : [e.target.value as 'video' | 'image'],
          })
        }
        aria-label="종류"
      >
        <option value="all">영상+이미지</option>
        <option value="video">영상</option>
        <option value="image">이미지</option>
      </select>
      <select
        className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
        value={query.minRating}
        onChange={(e) => onChange({ ...query, minRating: Number(e.target.value) })}
        aria-label="최소 평점"
      >
        <option value={0}>평점 전체</option>
        {[1, 2, 3, 4, 5].map((n) => (
          <option key={n} value={n}>
            {'★'.repeat(n)} 이상
          </option>
        ))}
      </select>
      <select
        className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
        value={query.label ?? ''}
        onChange={(e) =>
          onChange({
            ...query,
            label: e.target.value === '' ? null : (e.target.value as MediaLabel),
          })
        }
        aria-label="라벨"
      >
        <option value="">라벨 전체</option>
        {MEDIA_LABELS.map((l) => (
          <option key={l} value={l}>
            {LABEL_NAMES[l]}
          </option>
        ))}
      </select>
      <select
        className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
        value={query.tags[0] ?? ''}
        onChange={(e) =>
          onChange({ ...query, tags: e.target.value === '' ? [] : [e.target.value] })
        }
        aria-label="태그"
      >
        <option value="">태그 전체</option>
        {tags.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name} ({t.count})
          </option>
        ))}
      </select>
      <select
        className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
        value={query.compressed}
        onChange={(e) =>
          onChange({ ...query, compressed: e.target.value as LibraryQuery['compressed'] })
        }
        aria-label="압축 여부"
      >
        <option value="any">압축 여부 전체</option>
        <option value="no">아직 압축 안 함</option>
        <option value="yes">압축 작업 있음</option>
      </select>
      <select
        className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
        value={`${query.sort}:${query.order}`}
        onChange={(e) => {
          const [sort, order] = e.target.value.split(':') as [
            LibraryQuery['sort'],
            LibraryQuery['order'],
          ];
          onChange({ ...query, sort, order });
        }}
        aria-label="정렬"
      >
        <option value="name:asc">이름 ↑</option>
        <option value="name:desc">이름 ↓</option>
        <option value="date:desc">최근 수정</option>
        <option value="date:asc">오래된 수정</option>
        <option value="size:desc">큰 파일</option>
        <option value="size:asc">작은 파일</option>
        <option value="duration:desc">긴 영상</option>
        <option value="rating:desc">평점 높은 순</option>
      </select>
      <label className="flex items-center gap-1 text-xs">
        <input
          type="checkbox"
          checked={query.includeMissing}
          onChange={(e) => onChange({ ...query, includeMissing: e.target.checked })}
        />{' '}
        없어진 파일 포함
      </label>
      <span className="ml-auto flex gap-1">
        <Button
          variant={view === 'grid' ? 'primary' : 'ghost'}
          onClick={() => onView('grid')}
          aria-label="썸네일 보기"
        >
          ▦
        </Button>
        <Button
          variant={view === 'list' ? 'primary' : 'ghost'}
          onClick={() => onView('list')}
          aria-label="목록 보기"
        >
          ☰
        </Button>
      </span>
    </div>
  );
}

function DuplicatesPanel({
  groups,
  onClose,
  onPick,
}: {
  groups: DuplicateGroup[];
  onClose: () => void;
  onPick: (id: string) => void;
}): ReactNode {
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const verify = async (g: DuplicateGroup): Promise<void> => {
    const r = await libraryApi.verifyDuplicates(g.items.map((i) => i.id));
    if (r) setHashes((h) => ({ ...h, ...r.hashes }));
  };
  return (
    <section
      aria-label="중복 후보"
      className="max-h-56 overflow-y-auto rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-2 text-xs"
    >
      <div className="mb-1 flex items-center justify-between">
        <span className="font-semibold">
          중복 후보 {groups.length}묶음 (크기·길이 동일 기준. "해시 확인"으로 동일 파일을
          확정합니다. 삭제는 하지 않습니다.)
        </span>
        <Button onClick={onClose}>닫기</Button>
      </div>
      {groups.length === 0 && <p className="text-[var(--c-muted)]">중복 후보가 없습니다.</p>}
      {groups.map((g) => (
        <div key={g.key} className="mb-1 rounded border border-[var(--c-border)] p-1">
          <div className="flex items-center gap-2">
            <span>
              {formatBytes(g.sizeBytes)}
              {g.durationSec !== null ? ` · ${formatDuration(g.durationSec)}` : ''} ·{' '}
              {g.items.length}개
            </span>
            <Button onClick={() => void verify(g)}>해시 확인</Button>
          </div>
          <ul>
            {g.items.map((i) => (
              <li key={i.id} className="flex items-center gap-2">
                <button
                  type="button"
                  className="truncate text-left text-[var(--c-accent)] hover:underline"
                  onClick={() => onPick(i.id)}
                  title={i.path}
                >
                  {i.path}
                </button>
                {hashes[i.id] && (
                  <span className="font-mono text-[var(--c-muted)]">
                    {hashes[i.id]?.slice(0, 12)}…
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

export { LABEL_COLORS };
