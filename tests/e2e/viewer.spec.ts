/**
 * 킹뷰 E2E: 압축 파일(CBZ) 열기와 자연 정렬 목록, 탐색기 모드에서 장 고르기,
 * 재생목록 입력 칸에 숫자를 넣어도 보기 모드가 바뀌지 않는지 확인한다.
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
import { buildZip } from '../fixtures/zipBuilder';

let app: ElectronApplication;
let page: Page;
let workDir: string;

test.beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-e2e-viewer-'));
  const cbz = path.join(workDir, '묶음.cbz');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  fs.writeFileSync(
    cbz,
    buildZip([
      { name: 'p10.png', data: png },
      { name: 'readme.txt', data: Buffer.from('글') },
      { name: 'p2.png', data: png },
    ]),
  );

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
  // 파일 선택 대화상자 대신 준비한 압축 파일을 돌려준다
  await app.evaluate(({ dialog }, file: string) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, cbz);
});

test.afterAll(async () => {
  await app.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('킹뷰에서 압축 파일을 열면 이미지만 자연 정렬해서 보여 준다', async () => {
  await page.getByRole('button', { name: '킹뷰' }).click();
  await page.getByRole('button', { name: '파일 열기 (이미지·ZIP·CBZ)' }).click();
  // 텍스트 파일은 빠지고, p2 가 p10 보다 앞에 온다
  await expect(page.getByText('1 / 2 · p2.png')).toBeVisible({ timeout: 30_000 });
});

test('탐색기 모드에서 장을 고르면 그 장을 뷰어로 연다', async () => {
  await page.getByRole('button', { name: '탐색기 보기 (Ctrl+M)' }).click();
  await page.getByRole('button', { name: /2\. p10\.png/ }).click();
  await expect(page.getByText('2 / 2 · p10.png')).toBeVisible();
});

test('재생목록 이름 칸에 숫자를 입력해도 보기 모드가 바뀌지 않는다', async () => {
  await page.getByRole('button', { name: '재생목록' }).click();
  const input = page.getByLabel('새 재생목록 이름');
  await input.fill('2');
  await expect(input).toHaveValue('2');
  // 1장 보기가 그대로 켜져 있고, 2장 보기는 켜지지 않았다
  await expect(page.getByRole('button', { name: '1장 (1)' })).toHaveClass(
    /bg-\[var\(--c-accent\)\]/,
  );
  await expect(page.getByRole('button', { name: '2장 (2)' })).not.toHaveClass(
    /bg-\[var\(--c-accent\)\]/,
  );
});
