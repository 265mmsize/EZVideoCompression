/**
 * 라이브러리 E2E: 폴더 등록 → 인덱싱 → 썸네일 그리드 → 상세·재생 → 평점 → 대기열 추가 → 비교 탭.
 * 폴더 선택 대화상자만 메인 프로세스에서 스텁으로 대체한다.
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
let libDir: string;

test.beforeAll(async () => {
  const fixtures = generateAll();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-e2e-lib-'));
  libDir = path.join(workDir, '내 영상');
  fs.mkdirSync(path.join(libDir, '하위'), { recursive: true });
  fs.copyFileSync(fixtures['h264_sdr.mp4'], path.join(libDir, '여행 영상.mp4'));
  fs.copyFileSync(fixtures['hevc_10bit.mkv'], path.join(libDir, '하위', 'hevc 영상.mkv'));
  fs.copyFileSync(fixtures['no_audio.mp4'], path.join(libDir, '무음.mp4'));

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
  await app.evaluate(({ dialog }, dir: string) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, libDir);
});

test.afterAll(async () => {
  await app.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('폴더를 등록하면 인덱싱 후 썸네일 그리드에 항목이 보인다', async () => {
  await page.getByRole('button', { name: '라이브러리' }).click();
  // 기본값은 하위 폴더 미포함이므로 명시적으로 켠다
  await page.getByRole('checkbox', { name: '하위 폴더 포함' }).check();
  await page.getByRole('button', { name: '폴더 등록' }).click();
  const grid = page.getByRole('listbox', { name: '미디어 항목' });
  await expect(grid.getByRole('option')).toHaveCount(3, { timeout: 60_000 });
  // 썸네일은 전용 프로토콜 URL 로 로드된다
  const img = grid.getByRole('option').first().locator('img');
  await expect(img).toHaveAttribute('src', /^vslim-media:\/\/file\/[0-9a-f]{32}$/, {
    timeout: 60_000,
  });
  await expect
    .poll(async () => img.evaluate((el: { naturalWidth: number }) => el.naturalWidth), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  // 폴더 트리에 하위 폴더가 보인다
  await expect(
    page
      .getByRole('navigation', { name: '라이브러리 폴더' })
      .getByRole('button', { name: /^하위 \(1\)/ }),
  ).toBeVisible();
});

test('항목을 선택하면 상세 패널에서 직접 재생되고 평점을 매길 수 있다', async () => {
  const grid = page.getByRole('listbox', { name: '미디어 항목' });
  await grid.getByRole('option', { name: /여행 영상/ }).click();
  const detail = page.getByRole('complementary', { name: '미디어 상세' });
  await expect(detail).toBeVisible();
  const video = detail.locator('video');
  await expect(video).toHaveAttribute('src', /^vslim-media:\/\/file\//, { timeout: 30_000 });
  // 실제로 메타데이터를 읽어 길이를 알 수 있어야 한다 (Range 응답이 동작한다는 뜻)
  await expect
    .poll(async () => video.evaluate((el: { duration: number }) => el.duration), {
      timeout: 30_000,
    })
    .toBeGreaterThan(2);
  await detail.getByRole('radio', { name: '4점' }).click();
  await expect(detail.getByText('4점')).toBeVisible();
  await expect(grid.getByRole('option', { name: /여행 영상/ }).getByLabel('평점 4')).toBeVisible();
});

test('HEVC 항목은 프레임 보기로 열리고, 대기열 추가는 작업 목록에 반영된다', async () => {
  const grid = page.getByRole('listbox', { name: '미디어 항목' });
  await grid.getByRole('option', { name: /hevc 영상/ }).click();
  const detail = page.getByRole('complementary', { name: '미디어 상세' });
  await expect(detail.getByText('프레임 보기:')).toBeVisible({ timeout: 30_000 });
  await expect(detail.getByRole('slider', { name: '프레임 시점' })).toBeVisible();
  // 10비트 HEVC 는 기본 설정(H.264)에서 차단되므로, 설정 미리보기용으로는 H.264 SDR 항목을 대기열에 넣는다
  await grid.getByRole('option', { name: /여행 영상/ }).click();
  await detail.getByRole('button', { name: '압축 대기열에 추가' }).click();
  await page.getByRole('button', { name: '작업 목록' }).click();
  await expect(page.getByRole('row').filter({ hasText: '여행 영상.mp4' })).toBeVisible({
    timeout: 30_000,
  });
});

test('비교 탭에서 준비된 작업의 설정 미리보기를 만들고 양쪽 프레임을 본다', async () => {
  await page
    .getByRole('row')
    .filter({ hasText: '여행 영상.mp4' })
    .getByText('준비됨')
    .waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: '비교' }).click();
  const select = page.getByRole('combobox', { name: '비교할 작업' });
  const value = await select.locator('option', { hasText: '여행 영상.mp4' }).getAttribute('value');
  await select.selectOption(value ?? '');
  await page.getByRole('button', { name: '미리보기 인코딩' }).click();
  await expect(page.getByText(/설정 미리보기 \(/)).toBeVisible({ timeout: 120_000 });
  const frames = page.locator('img[alt$="프레임"]');
  await expect(frames).toHaveCount(2, { timeout: 60_000 });
  await expect
    .poll(async () => frames.first().evaluate((el: { naturalWidth: number }) => el.naturalWidth), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: '와이프' }).click();
  await expect(page.getByRole('slider', { name: '와이프 위치' })).toBeVisible();
});
