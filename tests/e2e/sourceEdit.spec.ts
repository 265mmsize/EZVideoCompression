/**
 * 편집 완성도 E2E: 구간만 내보내기 버튼(구간이 없으면 비활성), 클립 속성의 인터레이스 제거와 자막 가져오기 버튼.
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
import { generateAll } from '../fixtures/generate';

let app: ElectronApplication;
let page: Page;
let workDir: string;

test.beforeAll(async () => {
  const fixtures = generateAll();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-e2e-src-'));
  const clip = path.join(workDir, '원본.mp4');
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

test('구간만 내보내기는 구간이 없으면 비활성이고, 클립 속성에 인터레이스 제거와 자막 가져오기가 있다', async () => {
  await page.getByRole('button', { name: '영상 편집' }).click();
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '클립 추가' }).click();
  await expect(page.getByRole('list', { name: '타임라인' }).getByRole('listitem')).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: '선택 구간만 내보내기' })).toBeDisabled();
  await page.getByRole('list', { name: '타임라인' }).getByRole('listitem').first().click();
  await expect(page.getByRole('checkbox', { name: '인터레이스 제거' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '자막 파일 가져오기 (SRT·VTT·ASS)' }),
  ).toBeVisible();
});
