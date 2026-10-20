/**
 * Electron E2E: 실제 빌드(out/)를 띄워 UI 흐름을 검증한다.
 * 파일 선택 대화상자만 메인 프로세스에서 스텁으로 대체하고, 나머지는 사용자와 같은 방식으로 조작한다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { generateAll } from '../fixtures/generate';

let app: ElectronApplication;
let page: Page;
let workDir: string;

test.beforeAll(async () => {
  const fixtures = generateAll();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-e2e-'));
  // 원본 보호 검증을 위해 작업 폴더에 복사본을 둔다
  const dest = path.join(workDir, 'e2e 한글 입력.mp4');
  fs.copyFileSync(fixtures['h264_sdr.mp4'], dest);
  (globalThis as { __input?: string }).__input = dest;

  app = await electron.launch({
    args: [
      path.join(__dirname, '../../out/main/index.js'),
      // 테스트 실행마다 격리된 사용자 데이터(DB·로그)를 쓴다. 이전 실행의 기록이 섞이지 않게 한다.
      `--user-data-dir=${path.join(workDir, 'userData')}`,
      // 컨테이너는 root 로 실행되므로 샌드박스를 끈다. 이는 이 테스트 환경에만 해당한다.
      '--no-sandbox',
    ],
    env: { ...process.env, NODE_ENV: 'test' },
    timeout: 60_000,
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('창이 열리고 한국어 UI 와 FFmpeg 상태가 보인다', async () => {
  await expect(page.getByRole('heading', { name: 'VideoSlim Desktop' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: '작업 목록' })).toBeVisible();
  // FFmpeg 가 없으면 경고 배너가 뜬다. 있으면 뜨지 않아야 한다.
  await expect(page.getByText('FFmpeg 를 사용할 수 없어')).toHaveCount(0);
});

test('파일을 추가하면 분석을 거쳐 준비됨 상태가 되고, 시작하면 실제 인코딩 결과가 확정된다', async () => {
  const input = (globalThis as { __input?: string }).__input as string;
  const hashBefore = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');

  // 파일 선택 대화상자만 스텁으로 대체한다
  await app.evaluate(
    ({ dialog }, files: string[]) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    },
    [input],
  );

  await page.getByRole('button', { name: '파일 추가' }).click();
  const row = page.getByRole('row').filter({ hasText: 'e2e 한글 입력.mp4' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText('준비됨')).toBeVisible({ timeout: 60_000 });

  await row.getByRole('button', { name: /시작$/ }).click();
  // 완료 또는 크기 증가(no_savings) 중 하나로 끝나야 한다. 실패는 허용하지 않는다.
  await expect(row.getByText(/완료|크기 증가/)).toBeVisible({ timeout: 180_000 });

  // 원본은 바이트 단위로 변하지 않는다
  const hashAfter = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
  expect(hashAfter).toBe(hashBefore);
});

test('설정 화면에서 도구 경로와 테마를 확인하고 바꿀 수 있다', async () => {
  await page.getByRole('button', { name: '설정' }).click();
  await expect(page.getByText('찾음', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('combobox').first().selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('combobox').first().selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('이력 화면에 완료된 작업이 기록으로 남는다', async () => {
  await page.getByRole('button', { name: '이력' }).click();
  await expect(page.getByRole('cell', { name: 'e2e 한글 입력.mp4' })).toBeVisible({
    timeout: 30_000,
  });
});
