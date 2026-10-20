/**
 * 사용자 동작을 IPC 호출로 묶는다. 각 동작은 실제 결과를 기다린 뒤 화면을 바꾼다 (낙관적 성공 표시 없음).
 */
import { call } from './api';
import { errorText, notify, refreshJobs, setSettingsLocal, setToolsLocal } from './stores/appStore';
import type { AppSettings, JobSettings } from '../shared/types/domain';

async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    notify('error', `${label} 실패: ${errorText(err)}`);
    return undefined;
  }
}

export async function addFiles(): Promise<void> {
  const res = await run('파일 추가', () => call('jobs:pickFiles'));
  if (res) reportAdd(res.added.length, res.skipped.length);
  await refreshJobs();
}

export async function addFolder(includeSubfolders: boolean): Promise<void> {
  const res = await run('폴더 추가', () => call('jobs:pickFolder', { includeSubfolders }));
  if (res) reportAdd(res.added.length, res.skipped.length);
  await refreshJobs();
}

export async function addDropped(paths: string[], includeSubfolders: boolean): Promise<void> {
  const res = await run('드롭 추가', () => call('jobs:addPaths', { paths, includeSubfolders }));
  if (res) reportAdd(res.added.length, res.skipped.length);
  await refreshJobs();
}

function reportAdd(added: number, skipped: number): void {
  const parts = [`${String(added)}개 추가`];
  if (skipped > 0) parts.push(`${String(skipped)}개 건너뜀 (목록에서 사유 확인)`);
  notify(added > 0 ? 'info' : 'error', parts.join(', '));
}

export async function startQueue(ids: string[] | null): Promise<void> {
  await run('대기열 시작', () => call('jobs:start', { ids }));
  await refreshJobs();
}

export async function setPaused(paused: boolean): Promise<void> {
  await run('대기열 제어', () => call('queue:setPaused', { paused }));
}

export async function cancelJob(id: string): Promise<void> {
  await run('취소', () => call('jobs:cancel', { id }));
  await refreshJobs();
}

export async function retryJob(id: string): Promise<void> {
  await run('재시도', () => call('jobs:retry', { id }));
  await refreshJobs();
}

export async function unqueueJob(id: string): Promise<void> {
  await run('대기열에서 빼기', () => call('jobs:unqueue', { id }));
  await refreshJobs();
}

export async function removeJob(id: string): Promise<void> {
  await run('삭제', () => call('jobs:remove', { id }));
  await refreshJobs();
}

export async function moveJob(id: string, direction: 'up' | 'down'): Promise<void> {
  await run('순서 변경', () => call('jobs:move', { id, direction }));
  await refreshJobs();
}

export async function updateJobSettings(id: string, settings: Partial<JobSettings>): Promise<void> {
  await run('설정 변경', () => call('jobs:updateSettings', { id, settings }));
  await refreshJobs();
}

export async function saveAppSettings(
  patch: Partial<AppSettings>,
): Promise<AppSettings | undefined> {
  const next = await run('설정 저장', () => call('settings:update', patch));
  if (next) setSettingsLocal(next);
  return next;
}

export async function recheckTools(): Promise<void> {
  const tools = await run('도구 확인', () => call('tools:recheck'));
  if (tools) setToolsLocal(tools);
}

export async function showInFolder(path: string): Promise<void> {
  await run('폴더 열기', () => call('shell:showInFolder', { path }));
}

export async function exportLogs(maskPaths: boolean): Promise<void> {
  const res = await run('로그 내보내기', () => call('logs:export', { maskPaths }));
  if (res) notify('info', `로그를 저장했습니다: ${res.path}`);
}
