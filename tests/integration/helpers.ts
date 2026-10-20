/**
 * 통합 테스트 공용 도구: 격리된 작업 공간, 서비스 조립, 상태 대기.
 * 원본 픽스처는 건드리지 않도록 항상 작업 폴더로 복사해서 사용한다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServices, type AppServices } from '../../src/main/container';
import type { EventChannel } from '../../src/shared/contracts/ipc';
import type { JobView } from '../../src/shared/types/domain';
import { generateAll, type FixtureName } from '../fixtures/generate';

export interface Workspace {
  root: string;
  userData: string;
  inputDir: string;
  services: AppServices;
  events: { channel: EventChannel; payload: unknown }[];
  fixtures: Record<FixtureName, string>;
  cleanup: () => Promise<void>;
}

export function createWorkspace(prefix = 'vslim-test-'): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const userData = path.join(root, 'userData');
  const inputDir = path.join(root, 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  const events: { channel: EventChannel; payload: unknown }[] = [];
  const services = createServices({
    userDataDir: userData,
    bundledBinDir: null,
    exeSuffix: '',
    emit: (channel, payload) => {
      events.push({ channel, payload });
    },
  });
  return {
    root,
    userData,
    inputDir,
    services,
    events,
    fixtures: generateAll(),
    cleanup: async () => {
      await services.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 픽스처를 작업 폴더로 복사하고 복사본 경로를 돌려준다. 같은 이름이 있으면 임의 접미사를 붙인다. */
export function copyFixture(ws: Workspace, name: FixtureName, as?: string): string {
  const src = ws.fixtures[name];
  const base = as ?? path.basename(name);
  const dest = path.join(ws.inputDir, `${crypto.randomUUID().slice(0, 6)}-${base}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return dest;
}

/** 조건을 만족할 때까지 기다린다. 마지막 job:changed 페이로드를 돌려준다. */
export async function waitForJob(
  ws: Workspace,
  id: string,
  predicate: (job: JobView) => boolean,
  timeoutMs = 240_000,
): Promise<JobView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const latest = ws.events
      .filter((e) => e.channel === 'job:changed')
      .map((e) => e.payload as JobView)
      .filter((j) => j.id === id)
      .pop();
    if (latest && predicate(latest)) return latest;
    if (Date.now() > deadline) {
      const last = ws.services.queue.get(id);
      throw new Error(`시간 초과: 작업 ${id} 상태=${last.status} ${last.errorDetail ?? ''}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
