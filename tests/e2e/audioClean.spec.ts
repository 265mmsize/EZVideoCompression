/** 소리 정리 E2E: 속성 패널의 잡음 줄이기·보컬 선택 상자가 있고 값을 바꿀 수 있다 */
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
import { generateAll } from '../fixtures/generate';

let app: ElectronApplication;
let page: Page;
let workDir: string;

test.beforeAll(async () => {
  const fixtures = generateAll();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-e2e-clean-'));
  const clip = path.join(workDir, '소리 클립.mp4');
  fs.copyFileSync(fixtures['h264_sdr.mp4'], clip);
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
  await app.evaluate(({ dialog }, f: string) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, clip);
});

test.afterAll(async () => {
  await app.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('소리 정리 선택 상자에서 잡음 줄이기 정도를 고르면 값이 바뀐다', async () => {
  await page.getByRole('button', { name: '영상 편집' }).click();
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '클립 추가' }).click();
  await expect(page.getByRole('list', { name: '타임라인' }).getByRole('listitem')).toHaveCount(1, {
    timeout: 30_000,
  });
  await page.getByRole('list', { name: '타임라인' }).getByRole('listitem').first().click();
  const noise = page.getByRole('combobox', { name: '잡음 줄이기' });
  await expect(noise).toHaveValue('off');
  await noise.selectOption('strong');
  await expect(noise).toHaveValue('strong');
  // 보컬 옵션은 스테레오 원본에서만 켜지고, 아니면 이유를 보여 준다
  const vocal = page.getByRole('combobox', { name: '보컬 처리' });
  await expect(vocal).toBeVisible();
  await expect(page.getByText('소리 정리는 내보내기에만 반영')).toBeVisible();
});
