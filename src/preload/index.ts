/**
 * Preload: 렌더러에 노출할 제한된 API 를 contextBridge 로 공개한다.
 *
 * 설계 원칙
 * - 렌더러는 ipcRenderer 나 Node API 에 직접 접근할 수 없다.
 * - 채널은 계약(CHANNEL_NAMES)에 있는 것만 허용하고, 그 밖의 호출은 거부한다.
 * - 이벤트 구독은 해제 함수를 반환한다. 렌더러 언마운트 시 리스너를 반드시 제거한다.
 * - sandbox 프리로드이므로 import 는 electron 모듈과 계약 상수로 제한한다.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  CHANNEL_NAMES,
  type EventChannel,
  type EventContract,
  type InvokeChannel,
  type VideoSlimApi,
} from '../shared/contracts/ipc';

const invokable = new Set<string>(CHANNEL_NAMES.invoke);
const subscribable = new Set<string>(CHANNEL_NAMES.events);

const api: VideoSlimApi = {
  async invoke(channel: InvokeChannel, ...args: unknown[]): Promise<never> {
    if (!invokable.has(channel)) throw new Error(`허용되지 않은 채널: ${channel}`);
    const res = (await ipcRenderer.invoke(channel, args[0])) as
      { ok: true; data: unknown } | { ok: false; error: { code: string; detail: string | null } };
    if (!res.ok) {
      // 오류는 구조화된 형태로 렌더러에 전달한다. Error 객체의 스택은 노출하지 않는다.
      const err = new Error(res.error.code) as Error & { code: string; detail: string | null };
      err.code = res.error.code;
      err.detail = res.error.detail;
      throw err;
    }
    return res.data as never;
  },

  on<E extends EventChannel>(
    channel: E,
    listener: (payload: EventContract[E]) => void,
  ): () => void {
    if (!subscribable.has(channel)) throw new Error(`허용되지 않은 이벤트: ${channel}`);
    const wrapped = (_event: Electron.IpcRendererEvent, payload: EventContract[E]): void =>
      listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },

  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },

  platform: process.platform,
};

contextBridge.exposeInMainWorld('videoSlim', api);
