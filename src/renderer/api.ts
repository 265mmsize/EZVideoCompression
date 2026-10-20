/**
 * 렌더러에서 쓰는 API 래퍼.
 * preload 가 노출한 window.videoSlim 을 감싸, 오류를 코드가 붙은 RendererError 로 통일한다.
 */
import type {
  EventChannel,
  EventContract,
  InvokeChannel,
  InvokeContract,
  VideoSlimApi,
} from '../shared/contracts/ipc';
import type { ErrorCode } from '../shared/types/errors';

export class RendererError extends Error {
  constructor(
    readonly code: ErrorCode | 'UNKNOWN',
    readonly detail: string | null,
  ) {
    super(code);
    this.name = 'RendererError';
  }
}

declare global {
  interface Window {
    videoSlim: VideoSlimApi;
  }
}

function bridge(): VideoSlimApi {
  const api = (window as Partial<Window>).videoSlim;
  if (!api) {
    throw new RendererError('UNKNOWN', 'preload 브리지가 없습니다. 앱을 다시 시작하세요.');
  }
  return api;
}

/**
 * IPC 호출. 요청이 없는 채널은 request 를 생략한다.
 * 실패는 RendererError(코드·상세)로 던진다.
 */
export async function call<C extends InvokeChannel>(
  channel: C,
  request?: InvokeContract[C]['request'],
): Promise<InvokeContract[C]['response']> {
  // 채널별 튜플 타입은 호출 지점에서 이미 검사되므로, 여기서는 단일 인자 형태로 전달한다.
  const api = bridge() as unknown as {
    invoke: (c: string, r: unknown) => Promise<InvokeContract[C]['response']>;
  };
  try {
    return await api.invoke(channel, request);
  } catch (err) {
    const e = err as { code?: string; detail?: string | null; message?: string };
    const known = typeof e.code === 'string' ? e.code : null;
    throw new RendererError((known ?? 'UNKNOWN') as ErrorCode, e.detail ?? e.message ?? null);
  }
}

export function subscribe<E extends EventChannel>(
  channel: E,
  listener: (p: EventContract[E]) => void,
): () => void {
  return bridge().on(channel, listener);
}

export function pathOf(file: File): string {
  return bridge().getPathForFile(file);
}
