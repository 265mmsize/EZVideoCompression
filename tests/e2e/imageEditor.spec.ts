/**
 * 이미지 편집기 E2E: 이미지 열기(대화상자 스텁) → 자르기·회전 → 미리보기 갱신 → 저장 → 결과 파일 확인,
 * 그리고 화면 캡처(desktopCapturer, xvfb) → 편집기에 열림.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
let imagePath: string;
let capturesBefore: Set<string>;
let capturesDir: string;

test.beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-e2e-img-'));
  imagePath = path.join(workDir, '풍경 사진.jpg');
  const r = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=800x600:rate=1',
      '-frames:v',
      '1',
      '-pix_fmt',
      'yuvj420p',
      imagePath,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(r.stderr);

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
  await app.evaluate(({ dialog }, file: string) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, imagePath);
  capturesDir = await app.evaluate(({ app: a }) => a.getPath('pictures'));
  capturesDir = path.join(capturesDir, 'VideoSlim 캡처');
  capturesBefore = new Set(fs.existsSync(capturesDir) ? fs.readdirSync(capturesDir) : []);
});

test.afterAll(async () => {
  await app.close();
  fs.rmSync(workDir, { recursive: true, force: true });
  // 이 테스트가 만든 캡처 파일만 지운다
  if (fs.existsSync(capturesDir)) {
    for (const n of fs.readdirSync(capturesDir)) {
      if (!capturesBefore.has(n)) fs.rmSync(path.join(capturesDir, n), { force: true });
    }
  }
});

test('이미지를 열어 자르고 회전하면 미리보기와 결과 크기가 바뀌고, 저장하면 새 파일이 생긴다', async () => {
  await page.getByRole('button', { name: '이미지 편집' }).click();
  await page.getByRole('button', { name: '이미지 열기' }).click();
  const info = page.getByTestId('editor-info');
  await expect(info).toContainText('풍경 사진.jpg · 800×600', { timeout: 30_000 });
  const preview = page.getByTestId('editor-preview');
  await expect(preview).toHaveAttribute('src', /^vslim-media:\/\/file\//, { timeout: 30_000 });
  await expect
    .poll(async () => preview.evaluate((el: { naturalWidth: number }) => el.naturalWidth), {
      timeout: 30_000,
    })
    .toBe(800);

  // 숫자 입력으로 자르기 (400×300), 시계 방향 90° 회전 → 결과 300×400
  await page.getByRole('spinbutton', { name: '자르기 width' }).fill('400');
  await page.getByRole('spinbutton', { name: '자르기 height' }).fill('300');
  await page.getByRole('button', { name: '↻ 90°' }).click();
  await expect(info).toContainText('결과 300×400', { timeout: 30_000 });
  await expect
    .poll(
      async () =>
        preview.evaluate(
          (el: { naturalWidth: number; naturalHeight: number }) =>
            `${String(el.naturalWidth)}x${String(el.naturalHeight)}`,
        ),
      { timeout: 30_000 },
    )
    .toBe('300x400');

  // 선명하게 보정을 켜고 저장
  await page.getByRole('slider', { name: '선명하게' }).fill('1');
  await page.getByRole('button', { name: '같은 폴더에 저장' }).click();
  const result = page.getByTestId('export-result');
  await expect(result).toContainText('300×400', { timeout: 60_000 });
  const out = path.join(workDir, '풍경 사진-edit.jpg');
  expect(fs.existsSync(out)).toBe(true);
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out],
    { encoding: 'utf8' },
  );
  expect(probe.stdout.trim()).toBe('300,400');
  // 원본은 그대로
  expect(fs.statSync(imagePath).size).toBeGreaterThan(0);

  // 실행 취소로 회전을 되돌리면 결과 크기가 다시 바뀐다
  await page.getByRole('button', { name: '실행 취소' }).click();
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(info).toContainText('결과 400×300', { timeout: 30_000 });
});

test('화면 캡처 대화상자에서 화면을 고르면 PNG 가 저장되고 편집기에 열린다', async () => {
  await page.getByRole('button', { name: '화면 캡처' }).click();
  const dialog = page.getByRole('dialog', { name: '화면 캡처' });
  const options = dialog.getByRole('listbox', { name: '캡처 대상' }).getByRole('option');
  // 가상 화면에서는 목록이 비어 돌아올 때가 있어 새로 고침하며 기다린다
  await expect
    .poll(
      async () => {
        const n = await options.count();
        if (n === 0) await dialog.getByRole('button', { name: '목록 새로 고침' }).click();
        return n;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await options.first().click();
  // 창 관리자가 없는 xvfb 에서는 최소화가 동작하지 않으므로 끈다
  await dialog.getByRole('checkbox', { name: /최소화/ }).uncheck();
  await dialog.getByRole('button', { name: '캡처', exact: true }).click();
  const info = page.getByTestId('editor-info');
  await expect(info).toContainText(/캡처 \d{4}-\d{2}-\d{2} .*\.png/, { timeout: 60_000 });
  await expect(info).toContainText('png');
  const created = fs.readdirSync(capturesDir).filter((n) => !capturesBefore.has(n));
  expect(created).toHaveLength(1);
  expect(fs.statSync(path.join(capturesDir, created[0]!)).size).toBeGreaterThan(1000);
});
