/**
 * 영상 편집 마무리 E2E: 출력 설정의 HDR 동의·음량 맞춤·하드웨어 인코더 옵션이 보이고,
 * 같은 형식의 두 클립을 무손실로 합치면 "-merge" 파일이 생긴다.
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
let clipA: string;
let clipB: string;

test.beforeAll(async () => {
  const fixtures = generateAll();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-e2e-finish-'));
  clipA = path.join(workDir, '첫 클립.mp4');
  clipB = path.join(workDir, '둘째 클립.mp4');
  fs.copyFileSync(fixtures['h264_sdr.mp4'], clipA);
  fs.copyFileSync(fixtures['h264_sdr.mp4'], clipB);
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
  await app.evaluate(
    ({ dialog }, files: string[]) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    },
    [clipA, clipB],
  );
});

test.afterAll(async () => {
  await app.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('출력 설정에 HDR 동의·음량 맞춤·하드웨어 인코더 옵션이 있다', async () => {
  await page.getByRole('button', { name: '영상 편집' }).click();
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '클립 추가' }).click();
  await expect(page.getByRole('list', { name: '타임라인' }).getByRole('listitem')).toHaveCount(2, {
    timeout: 30_000,
  });
  await page.getByRole('tab', { name: '출력·진행' }).click();
  await expect(
    page.getByRole('checkbox', { name: 'HDR·10비트 원본을 SDR 8비트로 변환' }),
  ).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '클립 사이 음량 맞추기' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '하드웨어 인코더 사용' })).toBeVisible();
  // SDR 8비트 원본이라 경고가 없다
  await expect(page.getByText('HDR·10비트 원본이 있습니다')).toHaveCount(0);
});

test('같은 형식의 두 클립을 확인하고 무손실로 합친다', async () => {
  await page.getByRole('button', { name: '가능한지 확인' }).click();
  await expect(page.getByTestId('lossless-result')).toContainText('무손실로 합칠 수 있습니다', {
    timeout: 30_000,
  });
  await page.getByRole('button', { name: '무손실로 합치기' }).click();
  await expect(page.getByTestId('render-status')).toContainText('완료 (무손실)', {
    timeout: 60_000,
  });
  const out = fs.readdirSync(workDir).find((n) => n.endsWith('-merge.mp4'));
  expect(out).toBeTruthy();
});

test('음량 맞춤을 켜면 무손실 합치기가 안 되는 이유를 보여 준다', async () => {
  await page.getByRole('checkbox', { name: '클립 사이 음량 맞추기' }).check();
  await page.getByRole('button', { name: '가능한지 확인' }).click();
  await expect(page.getByTestId('lossless-result')).toContainText(
    '클립 사이 음량 맞춤이 켜져 있습니다',
    {
      timeout: 30_000,
    },
  );
  await expect(page.getByRole('button', { name: '무손실로 합치기' })).toBeDisabled();
});
