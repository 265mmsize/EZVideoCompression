/**
 * 유튜브 E2E: 기본은 꺼져 있어 플레이어가 없고, 주소 검사가 동작하며,
 * 설정에서 켠 뒤에만 임베드 프레임이 생기는지 확인한다. 네트워크 재생 자체는 확인하지 않는다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

let app: ElectronApplication;
let page: Page;
let workDir: string;

test.beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-e2e-yt-'));
  app = await electron.launch({
    args: [
      path.join(__dirname, '../../out/main/index.js'),
      `--user-data-dir=${path.join(workDir, 'userData')}`,
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

test('기본은 꺼져 있어 플레이어가 없고 설정으로 안내한다', async () => {
  await page.getByRole('button', { name: '유튜브', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('유튜브 임베드 재생이 꺼져 있습니다');
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('유튜브 주소가 아니면 거부 메시지를 보여 준다', async () => {
  await page.getByRole('textbox', { name: '유튜브 주소' }).fill('https://example.com/watch?v=abc');
  await page.getByRole('button', { name: '재생 준비' }).click();
  await expect(page.getByRole('alert')).toContainText('유튜브 영상 주소가 아닙니다');
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('설정에서 켜면 올바른 주소에 플레이어 프레임이 생긴다', async () => {
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByRole('checkbox', { name: /유튜브 임베드 재생 허용/ }).check();
  await page.getByRole('button', { name: '유튜브', exact: true }).click();
  await page
    .getByRole('textbox', { name: '유튜브 주소' })
    .fill('https://youtu.be/dQw4w9WgXcQ?t=30');
  await page.getByRole('button', { name: '재생 준비' }).click();
  const frame = page.locator('iframe[title="유튜브 플레이어"]');
  await expect(frame).toHaveCount(1);
  await expect(frame).toHaveAttribute('src', /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
  await expect(frame).toHaveAttribute('src', /start=30/);
});
