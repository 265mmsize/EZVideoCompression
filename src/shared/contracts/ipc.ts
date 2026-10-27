/**
 * IPC 계약 (Renderer ↔ Preload ↔ Main).
 *
 * - 채널 이름과 요청·응답 타입은 이 파일이 유일한 출처다.
 * - Main 은 src/shared/schemas/ipc.schemas.ts 의 zod 스키마로 모든 요청을 검증한다.
 * - Renderer 는 contextBridge 로 노출된 제한된 함수만 호출할 수 있다.
 */
import type {
  AddResult,
  AppSettings,
  CacheStats,
  CompressionMode,
  DuplicateGroup,
  IndexingState,
  JobSettings,
  JobView,
  LibraryItem,
  LibraryQuery,
  LibraryRoot,
  LibraryTreeNode,
  MediaLabel,
  MediaRef,
  MediaSource,
  PreviewAsset,
  PreviewProgress,
  QueueState,
  ToolStatus,
} from '../types/domain';
import type { AppErrorPayload } from '../types/errors';

/** 요청 → 응답 채널 */
export interface InvokeContract {
  'app:info': {
    request: void;
    response: { version: string; platform: string; isPackaged: boolean };
  };

  'tools:status': { request: void; response: ToolStatus };
  'tools:recheck': { request: void; response: ToolStatus };

  'settings:get': { request: void; response: AppSettings };
  'settings:update': { request: Partial<AppSettings>; response: AppSettings };

  /** 파일 선택 대화상자를 열고 선택된 파일을 추가한다. 취소 시 null */
  'jobs:pickFiles': { request: void; response: AddResult | null };
  /** 폴더 선택 대화상자를 열고 폴더 안의 영상 파일을 추가한다. 취소 시 null */
  'jobs:pickFolder': { request: { includeSubfolders: boolean }; response: AddResult | null };
  /** 드래그앤드롭 등으로 얻은 절대 경로를 추가한다 (파일·폴더 모두 허용) */
  'jobs:addPaths': {
    request: { paths: string[]; includeSubfolders: boolean };
    response: AddResult;
  };
  'jobs:list': { request: void; response: JobView[] };
  'jobs:updateSettings': {
    request: { id: string; settings: Partial<JobSettings> };
    response: JobView;
  };
  /** 같은 상태 그룹 안에서 순서를 한 칸 옮긴다 */
  'jobs:move': { request: { id: string; direction: 'up' | 'down' }; response: JobView[] };
  /** 분석이 끝난 작업(ready)을 실행 대기열(queued)로 넘긴다. ids 를 생략하면 전체 */
  'jobs:start': { request: { ids: string[] | null }; response: JobView[] };
  /** ready 상태로 되돌린다 (대기열에서 빼기) */
  'jobs:unqueue': { request: { id: string }; response: JobView };
  /** 현재 실행 중인 작업을 취소한다 */
  'jobs:cancel': { request: { id: string }; response: JobView };
  /** 실패·취소·중단·완료 작업을 처음부터 다시 분석한다 */
  'jobs:retry': { request: { id: string }; response: JobView };
  /** 샘플 기반 품질 추천을 계산한다 (준비됨 상태, 고품질·빠른 모드). 완료 시 추천 결과가 담긴 작업을 돌려준다. */
  'jobs:recommend': { request: { id: string }; response: JobView };
  /** 진행 중인 샘플 추천을 취소한다 */
  'jobs:cancelRecommend': { request: { id: string }; response: { cancelled: boolean } };
  /** 목록에서 작업 기록을 삭제한다. 원본과 결과 파일은 건드리지 않는다. */
  'jobs:remove': { request: { id: string }; response: { removed: boolean } };

  'queue:state': { request: void; response: QueueState };
  /** true 이면 현재 작업 완료 후 다음 작업을 시작하지 않는다 */
  'queue:setPaused': { request: { paused: boolean }; response: QueueState };

  'history:list': {
    request: { limit: number; offset: number };
    response: { items: JobView[]; total: number };
  };

  'shell:showInFolder': { request: { path: string }; response: { opened: boolean } };

  'logs:export': {
    request: { maskPaths: boolean };
    response: { path: string } | null;
  };

  // ----- 미디어 라이브러리 -----
  'library:roots.list': { request: void; response: LibraryRoot[] };
  /** 폴더 선택 대화상자를 열어 등록한다. 취소 시 null */
  'library:roots.add': { request: { includeSubfolders: boolean }; response: LibraryRoot | null };
  'library:roots.addPath': {
    request: { path: string; includeSubfolders: boolean };
    response: LibraryRoot;
  };
  /** 등록 해제. 파일은 건드리지 않고 항목·메타·캐시 기록만 지운다 */
  'library:roots.remove': { request: { id: string }; response: { removed: boolean } };
  'library:roots.reindex': { request: { id: string }; response: IndexingState };
  'library:indexing.state': { request: void; response: IndexingState };
  'library:indexing.cancel': { request: void; response: IndexingState };
  'library:tree': { request: { rootId: string }; response: LibraryTreeNode };
  'library:items.query': {
    request: LibraryQuery;
    response: { items: LibraryItem[]; total: number };
  };
  'library:item.get': { request: { id: string }; response: LibraryItem };
  'library:meta.set': {
    request: { id: string; rating?: number; label?: MediaLabel | null; note?: string | null };
    response: LibraryItem;
  };
  'library:tags.list': { request: void; response: { name: string; count: number }[] };
  'library:tags.set': { request: { id: string; tags: string[] }; response: LibraryItem };
  /** 썸네일 URL. 없으면 만들고(수 초 걸릴 수 있음), 만들 수 없으면 null */
  'library:thumb': { request: { id: string }; response: { url: string } | null };
  /** 영상 스크럽용 시점별 썸네일 URL 목록 (시간 순) */
  'library:scrub': {
    request: { id: string };
    response: { urls: string[]; timesSec: number[] };
  };
  /** 재생·표시용 소스 (전용 프로토콜 URL 과 재생 가능성 판정) */
  'library:source': { request: { ref: MediaRef }; response: MediaSource };
  /** 지정 시점 프레임(JPEG) URL */
  'library:frame': {
    request: { ref: MediaRef; timeSec: number };
    response: { url: string; timeSec: number };
  };
  /** 미리보기 프록시 생성 시작. 진행은 library:preview.progress 이벤트 */
  'library:proxy.create': { request: { id: string }; response: { previewId: string } };
  /** 현재 작업 설정으로 구간을 실제 인코딩하는 설정 미리보기 */
  'library:settingsPreview.create': {
    request: { jobId: string; startSec: number; durationSec: number };
    response: { previewId: string };
  };
  'library:preview.cancel': { request: { previewId: string }; response: { cancelled: boolean } };
  'library:previews.list': { request: { sourceKey: string }; response: PreviewAsset[] };
  'library:preview.remove': { request: { previewId: string }; response: { removed: boolean } };
  /** 선택 항목을 압축 대기열(작업 목록)에 추가 */
  'library:enqueue': { request: { ids: string[] }; response: AddResult };
  'library:duplicates': { request: void; response: DuplicateGroup[] };
  /** 그룹 항목의 SHA-256 을 계산해 동일 파일을 확정 */
  'library:duplicates.verify': {
    request: { ids: string[] };
    response: { hashes: Record<string, string> };
  };
  'library:cache.stats': { request: void; response: CacheStats };
  'library:cache.clear': { request: void; response: CacheStats };
}

/** 메인 → 렌더러 푸시 이벤트 */
export interface EventContract {
  'job:changed': JobView;
  'job:removed': { id: string };
  'queue:changed': QueueState;
  'tools:changed': ToolStatus;
  'library:indexing': IndexingState;
  'library:item.changed': LibraryItem;
  'library:preview.progress': PreviewProgress;
}

export type InvokeChannel = keyof InvokeContract;
export type EventChannel = keyof EventContract;

/** 실패 응답 래퍼. 메인은 예외를 이 형태로 직렬화해 돌려준다. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: AppErrorPayload };

/** 렌더러에 노출되는 API 형태 (preload 가 구현) */
export interface VideoSlimApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...args: InvokeContract[C]['request'] extends void ? [] : [InvokeContract[C]['request']]
  ): Promise<InvokeContract[C]['response']>;
  on<E extends EventChannel>(channel: E, listener: (payload: EventContract[E]) => void): () => void;
  /** 드롭된 File 객체의 실제 로컬 경로 (Electron 32+ 에서는 File.path 대신 사용) */
  getPathForFile(file: File): string;
  platform: string;
}

export const CHANNEL_NAMES = {
  invoke: [
    'app:info',
    'tools:status',
    'tools:recheck',
    'settings:get',
    'settings:update',
    'jobs:pickFiles',
    'jobs:pickFolder',
    'jobs:addPaths',
    'jobs:list',
    'jobs:updateSettings',
    'jobs:move',
    'jobs:start',
    'jobs:unqueue',
    'jobs:cancel',
    'jobs:retry',
    'jobs:remove',
    'jobs:recommend',
    'jobs:cancelRecommend',
    'queue:state',
    'queue:setPaused',
    'history:list',
    'shell:showInFolder',
    'logs:export',
    'library:roots.list',
    'library:roots.add',
    'library:roots.addPath',
    'library:roots.remove',
    'library:roots.reindex',
    'library:indexing.state',
    'library:indexing.cancel',
    'library:tree',
    'library:items.query',
    'library:item.get',
    'library:meta.set',
    'library:tags.list',
    'library:tags.set',
    'library:thumb',
    'library:scrub',
    'library:source',
    'library:frame',
    'library:proxy.create',
    'library:settingsPreview.create',
    'library:preview.cancel',
    'library:previews.list',
    'library:preview.remove',
    'library:enqueue',
    'library:duplicates',
    'library:duplicates.verify',
    'library:cache.stats',
    'library:cache.clear',
  ] satisfies InvokeChannel[],
  events: [
    'job:changed',
    'job:removed',
    'queue:changed',
    'tools:changed',
    'library:indexing',
    'library:item.changed',
    'library:preview.progress',
  ] satisfies EventChannel[],
} as const;

/** 메뉴·테스트 등에서 참조하기 위한 모드 표시 이름 */
export const MODE_LABELS: Readonly<Record<CompressionMode, string>> = {
  copy: '원본 유지',
  quality: '고품질 자동',
  fast: '빠른 압축',
  target: '목표 용량',
};
