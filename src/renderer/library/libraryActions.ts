/**
 * 라이브러리 화면의 IPC 호출 래퍼. 실패는 상단 알림으로 보여주고 undefined 를 돌려준다.
 */
import { call } from '../api';
import { errorText, notify, refreshJobs } from '../stores/appStore';
import type {
  ImageEditOps,
  ImageExportRequest,
  LibraryItem,
  LibraryQuery,
  MediaLabel,
  MediaRef,
  MediaSource,
} from '../../shared/types/domain';

async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    notify('error', `${label} 실패: ${errorText(err)}`);
    return undefined;
  }
}

export const libraryApi = {
  listRoots: () => run('폴더 목록', () => call('library:roots.list')),
  addRoot: (includeSubfolders: boolean) =>
    run('폴더 등록', () => call('library:roots.add', { includeSubfolders })),
  addRootPath: (path: string, includeSubfolders: boolean) =>
    run('폴더 등록', () => call('library:roots.addPath', { path, includeSubfolders })),
  removeRoot: (id: string) => run('폴더 등록 해제', () => call('library:roots.remove', { id })),
  reindex: (id: string) => run('다시 인덱싱', () => call('library:roots.reindex', { id })),
  cancelIndexing: () => run('인덱싱 취소', () => call('library:indexing.cancel')),
  tree: (rootId: string) => run('폴더 트리', () => call('library:tree', { rootId })),
  query: (q: LibraryQuery) => run('목록 조회', () => call('library:items.query', q)),
  get: (id: string) => run('항목 조회', () => call('library:item.get', { id })),
  setMeta: (
    id: string,
    patch: { rating?: number; label?: MediaLabel | null; note?: string | null },
  ) => run('메타 저장', () => call('library:meta.set', { id, ...patch })),
  tags: () => run('태그 목록', () => call('library:tags.list')),
  setTags: (id: string, tags: string[]) =>
    run('태그 저장', () => call('library:tags.set', { id, tags })),
  /** 썸네일은 실패해도 알림을 띄우지 않는다 (목록에 조용히 빈 칸으로 둔다) */
  thumb: async (id: string): Promise<string | null> => {
    try {
      return (await call('library:thumb', { id }))?.url ?? null;
    } catch {
      return null;
    }
  },
  scrub: async (id: string): Promise<{ urls: string[]; timesSec: number[] }> => {
    try {
      return await call('library:scrub', { id });
    } catch {
      return { urls: [], timesSec: [] };
    }
  },
  source: (ref: MediaRef): Promise<MediaSource | undefined> =>
    run('미디어 열기', () => call('library:source', { ref })),
  frame: (ref: MediaRef, timeSec: number) =>
    run('프레임 추출', () => call('library:frame', { ref, timeSec })),
  createProxy: (id: string) => run('변환본 생성', () => call('library:proxy.create', { id })),
  createSettingsPreview: (jobId: string, startSec: number, durationSec: number) =>
    run('설정 미리보기', () =>
      call('library:settingsPreview.create', { jobId, startSec, durationSec }),
    ),
  cancelPreview: (previewId: string) =>
    run('미리보기 취소', () => call('library:preview.cancel', { previewId })),
  previews: (sourceKey: string) =>
    run('미리보기 목록', () => call('library:previews.list', { sourceKey })),
  removePreview: (previewId: string) =>
    run('미리보기 삭제', () => call('library:preview.remove', { previewId })),
  enqueue: async (ids: string[]): Promise<void> => {
    const res = await run('대기열에 추가', () => call('library:enqueue', { ids }));
    if (res) {
      notify(
        res.added.length > 0 ? 'info' : 'error',
        `${String(res.added.length)}개를 작업 목록에 추가했습니다${res.skipped.length > 0 ? `, ${String(res.skipped.length)}개 건너뜀` : ''}`,
      );
      await refreshJobs();
    }
  },
  duplicates: () => run('중복 찾기', () => call('library:duplicates')),
  verifyDuplicates: (ids: string[]) =>
    run('해시 확인', () => call('library:duplicates.verify', { ids })),
  cacheStats: () => run('캐시 상태', () => call('library:cache.stats')),
  clearCache: () => run('캐시 비우기', () => call('library:cache.clear')),
  showInFolder: (path: string) => run('폴더 열기', () => call('shell:showInFolder', { path })),

  // ----- 이미지 편집 · 화면 캡처 -----
  imageOpen: (path: string) => run('이미지 열기', () => call('image:open', { path })),
  imagePickOpen: () => run('이미지 열기', () => call('image:pickOpen')),
  /** 미리보기는 새 요청으로 취소될 수 있으므로 알림 없이 undefined 를 돌려준다 */
  imagePreview: async (path: string, ops: ImageEditOps, maxWidth: number) => {
    try {
      return await call('image:preview', { path, ops, maxWidth });
    } catch (err) {
      if ((err as { code?: string }).code === 'CANCELLED') return undefined;
      notify('error', `미리보기 실패: ${errorText(err)}`);
      return undefined;
    }
  },
  imageExport: (req: ImageExportRequest) => run('이미지 저장', () => call('image:export', req)),
  imagePickSavePath: (defaultName: string, format: 'jpeg' | 'png' | 'webp') =>
    run('저장 위치 선택', () => call('image:pickSavePath', { defaultName, format })),
  captureSources: () => run('캡처 대상 목록', () => call('capture:sources')),
  captureTake: (sourceId: string, delaySec: number, hideApp: boolean) =>
    run('화면 캡처', () => call('capture:take', { sourceId, delaySec, hideApp })),
};

export type ItemPatch = Partial<Pick<LibraryItem, 'rating' | 'label' | 'note'>>;

export const LABEL_COLORS: Record<MediaLabel, string> = {
  red: '#e5484d',
  orange: '#f76b15',
  yellow: '#ffc53d',
  green: '#30a46c',
  blue: '#3e63dd',
  purple: '#8e4ec6',
};

export const LABEL_NAMES: Record<MediaLabel, string> = {
  red: '빨강',
  orange: '주황',
  yellow: '노랑',
  green: '초록',
  blue: '파랑',
  purple: '보라',
};
