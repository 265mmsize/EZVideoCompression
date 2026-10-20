/**
 * IPC 핸들러 등록.
 *
 * 모든 요청은 1) 채널 존재 확인 2) zod 스키마 검증 3) 핸들러 실행 순서로 처리한다.
 * 예외는 AppError 로 바뀌어 { ok:false, error } 형태로 렌더러에 돌아간다. 원시 예외를 노출하지 않는다.
 */
import fs from 'node:fs';
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import {
  CHANNEL_NAMES,
  type InvokeChannel,
  type InvokeContract,
  type IpcResult,
} from '../../shared/contracts/ipc';
import { invokeSchemas } from '../../shared/schemas/ipc.schemas';
import type { AppServices } from '../container';
import { AppError } from '../services/AppError';
import { toView } from '../repositories/JobRepository';

/** 파일/폴더 대화상자와 저장 대화상자는 창 의존이므로 주입받는다 */
export interface DialogPort {
  pickFiles: () => Promise<string[] | null>;
  pickFolder: () => Promise<string | null>;
  saveLogFile: (defaultName: string) => Promise<string | null>;
}

export interface IpcDeps {
  services: AppServices;
  dialogs: DialogPort;
  appVersion: string;
  isPackaged: boolean;
}

type Handler<C extends InvokeChannel> = (
  request: InvokeContract[C]['request'],
) => Promise<InvokeContract[C]['response']> | InvokeContract[C]['response'];

export function registerIpc(deps: IpcDeps): void {
  const { services: s, dialogs } = deps;

  const handlers: { [C in InvokeChannel]: Handler<C> } = {
    'app:info': () => ({
      version: deps.appVersion,
      platform: process.platform,
      isPackaged: deps.isPackaged,
    }),

    'tools:status': () => s.toolStatus() ?? emptyToolStatus(),
    'tools:recheck': () => s.refreshTools(),

    'settings:get': () => s.settings.get(),
    'settings:update': async (patch) => {
      const before = s.settings.get();
      const next = s.settings.update(patch);
      // 도구 경로가 바뀌었을 때만 다시 탐지한다
      if (before.ffmpegPath !== next.ffmpegPath || before.ffprobePath !== next.ffprobePath) {
        await s.refreshTools();
      }
      return next;
    },

    'jobs:pickFiles': async () => {
      const paths = await dialogs.pickFiles();
      if (!paths) return null;
      return s.queue.addPaths(paths, false);
    },
    'jobs:pickFolder': async ({ includeSubfolders }) => {
      const folder = await dialogs.pickFolder();
      if (!folder) return null;
      return s.queue.addPaths([folder], includeSubfolders);
    },
    'jobs:addPaths': ({ paths, includeSubfolders }) => s.queue.addPaths(paths, includeSubfolders),
    'jobs:list': () => s.queue.list(),
    'jobs:updateSettings': ({ id, settings }) => s.queue.updateSettings(id, settings),
    'jobs:move': ({ id, direction }) => s.queue.move(id, direction),
    'jobs:start': ({ ids }) => s.queue.start(ids),
    'jobs:unqueue': ({ id }) => s.queue.unqueue(id),
    'jobs:cancel': ({ id }) => s.queue.cancel(id),
    'jobs:retry': ({ id }) => s.queue.retry(id),
    'jobs:remove': ({ id }) => ({ removed: s.queue.remove(id) }),

    'queue:state': () => s.queue.queueState(),
    'queue:setPaused': ({ paused }) => s.queue.setPaused(paused),

    'history:list': ({ limit, offset }) => {
      const page = s.jobs.history(limit, offset);
      return { items: page.items.map(toView), total: page.total };
    },

    'shell:showInFolder': ({ path }) => {
      if (!fs.existsSync(path)) throw new AppError('INPUT_MISSING', path);
      shell.showItemInFolder(path);
      return { opened: true };
    },

    'logs:export': async ({ maskPaths }) => {
      const target = await dialogs.saveLogFile(
        `videoslim-log-${new Date().toISOString().slice(0, 10)}.txt`,
      );
      if (!target) return null;
      s.logger.exportTo(target, maskPaths);
      return { path: target };
    },
  };

  for (const channel of CHANNEL_NAMES.invoke) {
    registerChannel(channel, handlers, s);
  }
}

/**
 * 채널 하나를 등록한다. 제네릭으로 묶어 채널별 요청·응답 타입이 끝까지 유지되게 한다.
 */
// C 는 본문의 핸들러 조회와 요청 타입 단언을 채널별로 묶기 위해 필요하다.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function registerChannel<C extends InvokeChannel>(
  channel: C,
  handlers: { [K in InvokeChannel]: Handler<K> },
  s: AppServices,
): void {
  const schema = invokeSchemas[channel];
  ipcMain.removeHandler(channel);
  ipcMain.handle(
    channel,
    async (_event: IpcMainInvokeEvent, raw: unknown): Promise<IpcResult<unknown>> => {
      try {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          throw new AppError(
            'INVALID_REQUEST',
            parsed.error.issues.map((i) => i.message).join('; '),
          );
        }
        const data = await handlers[channel](parsed.data as InvokeContract[C]['request']);
        return { ok: true, data };
      } catch (err) {
        const app = AppError.from(err);
        s.logger.warn('ipc error', { channel, code: app.code, detail: app.detail });
        return { ok: false, error: app.toPayload() };
      }
    },
  );
}

function emptyToolStatus(): import('../../shared/types/domain').ToolStatus {
  const none = {
    path: null,
    source: 'missing' as const,
    version: null,
    error: '아직 탐지하지 않았습니다',
  };
  return {
    ffmpeg: { name: 'ffmpeg', ...none },
    ffprobe: { name: 'ffprobe', ...none },
    ready: false,
    encoders: [],
  };
}
