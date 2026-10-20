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
  CompressionMode,
  JobSettings,
  JobView,
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
}

/** 메인 → 렌더러 푸시 이벤트 */
export interface EventContract {
  'job:changed': JobView;
  'job:removed': { id: string };
  'queue:changed': QueueState;
  'tools:changed': ToolStatus;
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
    'queue:state',
    'queue:setPaused',
    'history:list',
    'shell:showInFolder',
    'logs:export',
  ] satisfies InvokeChannel[],
  events: ['job:changed', 'job:removed', 'queue:changed', 'tools:changed'] satisfies EventChannel[],
} as const;

/** 메뉴·테스트 등에서 참조하기 위한 모드 표시 이름 */
export const MODE_LABELS: Readonly<Record<CompressionMode, string>> = {
  copy: '원본 유지',
  quality: '고품질 자동',
  fast: '빠른 압축',
  target: '목표 용량',
};
