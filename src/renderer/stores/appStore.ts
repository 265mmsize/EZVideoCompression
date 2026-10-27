/**
 * 앱 상태 저장소. 외부 라이브러리 없이 구독형 스토어로 구현했다 (useSyncExternalStore 와 함께 사용).
 * 메인 프로세스의 푸시 이벤트를 받아 작업 목록을 갱신한다.
 */
import type {
  AppSettings,
  IndexingState,
  JobView,
  PreviewProgress,
  QueueState,
  ToolStatus,
} from '../../shared/types/domain';
import { call, subscribe, RendererError } from '../api';

export interface AppState {
  jobs: JobView[];
  queue: QueueState;
  tools: ToolStatus | null;
  settings: AppSettings | null;
  ready: boolean;
  /** 화면 상단에 한 번 보여줄 알림 */
  notice: { kind: 'info' | 'error'; text: string; id: number } | null;
  indexing: IndexingState;
  /** 미리보기 생성 진행 상태 (ID 별 최신값) */
  previews: Record<string, PreviewProgress>;
}

let state: AppState = {
  jobs: [],
  queue: { paused: false, runningJobId: null },
  tools: null,
  settings: null,
  ready: false,
  notice: null,
  indexing: {
    running: false,
    rootId: null,
    processed: 0,
    total: 0,
    currentFile: null,
    lastError: null,
  },
  previews: {},
};
const listeners = new Set<() => void>();
let noticeSeq = 0;

export function getState(): AppState {
  return state;
}

export function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

const NOTICE_MS = 6000;

/** 알림을 띄우고 일정 시간 뒤 같은 알림이면 지운다 */
export function notify(kind: 'info' | 'error', text: string): void {
  noticeSeq += 1;
  const id = noticeSeq;
  set({ notice: { kind, text, id } });
  setTimeout(() => {
    if (state.notice?.id === id) set({ notice: null });
  }, NOTICE_MS);
}

export function errorText(err: unknown): string {
  if (err instanceof RendererError) {
    return `${err.code}${err.detail ? `: ${err.detail}` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** 목록을 서버 기준으로 다시 읽는다 (정렬·위치 정보 포함) */
export async function refreshJobs(): Promise<void> {
  const jobs = await call('jobs:list');
  set({ jobs });
}

function upsertJob(job: JobView): void {
  const idx = state.jobs.findIndex((j) => j.id === job.id);
  const jobs = idx >= 0 ? state.jobs.map((j, i) => (i === idx ? job : j)) : [...state.jobs, job];
  // 같은 대기열 안의 위치가 바뀔 수 있으므로 queuePosition 기준 정렬은 서버 목록 갱신 때 맞춘다
  set({ jobs });
}

export async function initStore(): Promise<void> {
  // 초기 조회가 끝나기 전에 도착하는 이벤트를 놓치지 않도록 구독을 먼저 건다. 목록 조회 결과가 최종 기준이다.
  subscribe('job:changed', (job) => {
    upsertJob(job);
    // 대기열 위치가 바뀌었을 수 있으므로 가벼운 전체 갱신을 예약한다
    if (job.status === 'queued' || job.status === 'ready') scheduleRefresh();
  });
  subscribe('job:removed', ({ id }) => set({ jobs: state.jobs.filter((j) => j.id !== id) }));
  subscribe('queue:changed', (queue) => set({ queue }));
  subscribe('tools:changed', (tools) => set({ tools }));
  subscribe('library:indexing', (indexing) => set({ indexing }));
  subscribe('library:preview.progress', (p) =>
    set({ previews: { ...state.previews, [p.previewId]: p } }),
  );

  const [settings, tools, queue, jobs, indexing] = await Promise.all([
    call('settings:get'),
    call('tools:status'),
    call('queue:state'),
    call('jobs:list'),
    call('library:indexing.state'),
  ]);
  set({ settings, tools, queue, jobs, indexing, ready: true });
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshJobs();
  }, 150);
}

export function setSettingsLocal(settings: AppSettings): void {
  set({ settings });
}

export function setToolsLocal(tools: ToolStatus): void {
  set({ tools });
}
