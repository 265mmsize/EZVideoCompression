/**
 * 영상 편집기 추가 트랙·키프레임·파형 E2E:
 * 메인 클립 파형 → 영상 트랙에 이미지 → 불투명도 키프레임 2개(자동 키) → 실행 취소 →
 * 오디오 트랙에 소리와 파형 → 트랙 클립 끌어 옮기기와 실행 취소 → 트랙 포함 미리보기 재생 → 내보내기.
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
import { generateAll } from '../fixtures/generate';

let app: ElectronApplication;
let page: Page;
let workDir: string;
let clipPath: string;
let logoPath: string;
let soundPath: string;

function ff(args: string[]): void {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

/** 다음 파일 선택 대화상자가 이 파일을 돌려주게 한다 */
async function nextPick(file: string): Promise<void> {
  await app.evaluate(({ dialog }, f: string) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, file);
}

test.beforeAll(async () => {
  const fixtures = generateAll();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-e2e-tracks-'));
  clipPath = path.join(workDir, '바탕 클립.mp4');
  fs.copyFileSync(fixtures['h264_sdr.mp4'], clipPath);
  logoPath = path.join(workDir, '로고.png');
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=200x100', '-frames:v', '1', logoPath]);
  soundPath = path.join(workDir, '효과음.wav');
  ff(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=2', soundPath]);

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

test('메인 클립에 파형이 그려진다', async () => {
  await page.getByRole('button', { name: '영상 편집' }).click();
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await nextPick(clipPath);
  await page.getByRole('button', { name: '클립 추가' }).click();
  const main = page.getByRole('list', { name: '타임라인' }).getByRole('listitem');
  await expect(main).toHaveCount(1, { timeout: 30_000 });
  await expect(main.first().getByTestId('waveform')).toBeAttached({ timeout: 30_000 });
});

test('영상 트랙에 이미지를 넣고 불투명도 키프레임 두 개를 만든 뒤 하나를 되돌린다', async () => {
  await page.getByRole('button', { name: '+ 영상 트랙' }).click();
  const row = page.getByRole('list', { name: '트랙: 영상 1' });
  await expect(row).toBeVisible();
  await page.keyboard.press('Home');
  await nextPick(logoPath);
  await row.getByRole('button', { name: '+ 이미지' }).click();
  await expect(row.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole('spinbutton', { name: '표시 길이 (초)' })).toHaveValue('5');

  // 0초에 키프레임 → 1초로 이동 → 슬라이더를 움직이면 그 시점에 자동으로 키프레임이 생긴다
  await page.getByRole('button', { name: '불투명도 키프레임 넣기' }).click();
  await page.keyboard.press('Shift+ArrowRight');
  await page.getByRole('slider', { name: '불투명도' }).fill('0.3');
  await expect(page.getByText('불투명도 0.30 · 키프레임 2개')).toBeVisible();
  await expect(row.getByTestId('keyframe-mark')).toHaveCount(2);

  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(page.getByText(/불투명도 1\.00 · 키프레임 1개/)).toBeVisible();
  await page.getByRole('button', { name: '다시 실행' }).click();
  await expect(row.getByTestId('keyframe-mark')).toHaveCount(2);
});

test('오디오 트랙에 소리를 넣으면 파형이 보인다', async () => {
  await page.getByRole('button', { name: '+ 오디오 트랙' }).click();
  const row = page.getByRole('list', { name: '트랙: 오디오 1' });
  await nextPick(soundPath);
  await row.getByRole('button', { name: '+ 소리' }).click();
  await expect(row.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
  await expect(row.getByTestId('waveform')).toBeAttached({ timeout: 30_000 });
});

test('트랙 클립을 끌어 옮기고 실행 취소로 되돌린다', async () => {
  const row = page.getByRole('list', { name: '트랙: 영상 1' });
  const item = row.getByRole('listitem').first();
  await item.click();
  const start = page.getByRole('spinbutton', { name: '타임라인 시작 (초)' });
  await expect(start).toHaveValue('0');
  const box = await item.boundingBox();
  if (!box) throw new Error('트랙 클립을 찾지 못했습니다');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 50, y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Number(await start.inputValue())).toBeGreaterThan(0.5);
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(start).toHaveValue('0');
});

test('트랙이 있어도 미리보기가 재생되고 이미지 오버레이가 화면에 나온다', async () => {
  const slider = page.getByRole('slider', { name: '재생 헤드' });
  await page.keyboard.press('Home');
  await page.getByRole('button', { name: '미리보기 재생' }).click();
  const preview = page.getByTestId('timeline-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('img[data-testid="track-media"]')).toHaveCSS('display', 'block', {
    timeout: 15_000,
  });
  await expect
    .poll(async () => Number(await slider.inputValue()), { timeout: 15_000 })
    .toBeGreaterThan(0.8);
  await page.getByRole('button', { name: '미리보기 정지' }).click();
  await expect(preview).toHaveCount(0);
});

test('트랙과 키프레임이 들어간 프로젝트를 내보낸다', async () => {
  await page.getByRole('tab', { name: '출력·진행' }).click();
  await page.getByRole('combobox', { name: '출력 프리셋' }).selectOption('veryfast');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await expect(page.getByTestId('render-status')).toContainText('저장됨', { timeout: 180_000 });
  const out = fs.readdirSync(workDir).find((n) => n.endsWith('-edit.mp4'));
  expect(out).toBeTruthy();
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      path.join(workDir, out!),
    ],
    { encoding: 'utf8' },
  );
  expect(probe.stdout.trim().split('\n').sort()).toEqual(['audio', 'video']);
});
