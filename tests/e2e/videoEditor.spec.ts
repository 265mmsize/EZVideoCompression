/**
 * 영상 편집기 E2E: 프로젝트 생성 → 클립 추가(대화상자 스텁) → 재생 헤드 분할 → 전환·텍스트 설정 → 내보내기 → 결과 파일 확인.
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

test.beforeAll(async () => {
  const fixtures = generateAll();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-e2e-edit-'));
  clipPath = path.join(workDir, '여행 클립.mp4');
  fs.copyFileSync(fixtures['h264_sdr.mp4'], clipPath);

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
  }, clipPath);
});

test.afterAll(async () => {
  await app.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('클립을 추가해 분할하고 전환·텍스트를 넣어 내보내면 새 파일이 생긴다', async () => {
  await page.getByRole('button', { name: '영상 편집' }).click();
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '클립 추가' }).click();
  const timeline = page.getByRole('list', { name: '타임라인' });
  await expect(timeline.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId('edit-frame')).toHaveAttribute('src', /^vslim-media:\/\/file\//, {
    timeout: 30_000,
  });

  // 재생 헤드를 1.5초로 옮겨 분할 → 클립 2개
  await page.getByRole('slider', { name: '재생 헤드' }).fill('1.5');
  await page.getByRole('button', { name: '재생 헤드에서 분할' }).click();
  await expect(timeline.getByRole('listitem')).toHaveCount(2);

  // 첫 클립: 전환 페이드, 텍스트 추가
  await timeline.getByRole('listitem').first().click();
  await page.getByRole('combobox', { name: '전환 종류' }).selectOption('fade');
  await page.getByRole('slider', { name: '전환 길이 (초)' }).fill('0.4');
  await page.getByRole('button', { name: '텍스트 추가' }).click();
  await page.getByRole('textbox', { name: '텍스트 내용' }).fill('E2E 자막');
  await expect(timeline.getByRole('listitem').first()).toContainText('T1');
  await expect(page.getByText(/전체 0:0[23]/)).toBeVisible();

  // 출력: 빠른 프리셋으로 내보내기
  await page.getByRole('tab', { name: '출력·진행' }).click();
  await page.getByRole('combobox', { name: '출력 프리셋' }).selectOption('veryfast');
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  const status = page.getByTestId('render-status');
  await expect(status).toContainText('저장됨', { timeout: 180_000 });
  const out = fs.readdirSync(workDir).find((n) => n.endsWith('-edit.mp4'));
  expect(out).toBeTruthy();
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(workDir, out!)],
    { encoding: 'utf8' },
  );
  // 3초 원본을 분할했으므로 전환 0.4초만큼 줄어든 약 2.6초
  expect(Math.abs(Number(probe.stdout.trim()) - 2.6)).toBeLessThan(0.3);
  // 원본은 그대로
  expect(fs.existsSync(clipPath)).toBe(true);
});

test('실행 취소로 분할을 되돌리고 다시 실행으로 복구한다', async () => {
  await page.getByRole('button', { name: '영상 편집' }).click();
  // 앞 테스트에서 열어 둔 프로젝트가 있으면 목록으로 돌아간다
  const back = page.getByRole('button', { name: '← 프로젝트 목록' });
  if (await back.count()) await back.click();
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '클립 추가' }).click();
  const timeline = page.getByRole('list', { name: '타임라인' });
  await expect(timeline.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole('slider', { name: '재생 헤드' }).fill('1');
  await page.getByRole('button', { name: '재생 헤드에서 분할' }).click();
  await expect(timeline.getByRole('listitem')).toHaveCount(2);

  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(timeline.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: '다시 실행' }).click();
  await expect(timeline.getByRole('listitem')).toHaveCount(2);
});

test('키보드로 구간을 고르고 잔물결 삭제한 뒤 실행 취소로 되돌린다', async () => {
  await page.getByRole('button', { name: '영상 편집' }).click();
  const back = page.getByRole('button', { name: '← 프로젝트 목록' });
  if (await back.count()) await back.click();
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '클립 추가' }).click();
  const items = page.getByRole('list', { name: '타임라인' }).getByRole('listitem');
  await expect(items).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByText(/클립 1개/)).toBeVisible();

  // 1초에서 시작 (I), 2초에서 끝 (O) → 가운데 1초 구간을 잘라낸다
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('i');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('o');
  await expect(page.getByRole('button', { name: '구간 삭제 (Delete)' })).toBeVisible();

  await page.keyboard.press('Delete');
  await expect(items).toHaveCount(2);
  await expect(page.getByText(/클립 2개/)).toBeVisible();

  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(items).toHaveCount(1);
  await expect(page.getByText(/클립 1개/)).toBeVisible();
});

test('클립 끝을 끌어 줄이면 길이가 줄고, 실행 취소로 되돌린다', async () => {
  const clip = page.getByRole('list', { name: '타임라인' }).getByRole('listitem').first();
  const before = await clip.boundingBox();
  const handle = clip.locator('div[title^="끝 조절"]');
  const h = await handle.boundingBox();
  if (!before || !h) throw new Error('클립 또는 끝 조절 핸들을 찾지 못했습니다');
  const y = h.y + h.height / 2;
  await page.mouse.move(h.x + h.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 40, y, { steps: 6 });
  await page.mouse.up();
  const after = await clip.boundingBox();
  expect(after?.width ?? 0).toBeLessThan(before.width - 20);

  await page.getByRole('button', { name: '실행 취소' }).click();
  const restored = await clip.boundingBox();
  expect(Math.abs((restored?.width ?? 0) - before.width)).toBeLessThan(2);
});

test('눈금을 끌어 구간을 고르고 Esc 로 해제한다', async () => {
  const ruler = page.getByTestId('timeline-ruler');
  const box = await ruler.boundingBox();
  if (!box) throw new Error('눈금을 찾지 못했습니다');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 20, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '구간 삭제 (Delete)' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '구간 삭제 (Delete)' })).toHaveCount(0);
});

test('Ctrl+클릭으로 여러 클립을 고르고 한 번에 지운 뒤 되돌린다', async () => {
  // 재생 헤드(1초)에서 S 키로 나누어 클립 2개를 만든다
  await page.keyboard.press('s');
  const items = page.getByRole('list', { name: '타임라인' }).getByRole('listitem');
  await expect(items).toHaveCount(2);
  await items.nth(0).click();
  await items.nth(1).click({ modifiers: ['Control'] });
  await expect(page.getByRole('button', { name: '고른 클립 2개 삭제' })).toBeVisible();
  await page.getByRole('button', { name: '고른 클립 2개 삭제' }).click();
  await expect(items).toHaveCount(0);
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(items).toHaveCount(2);
});
