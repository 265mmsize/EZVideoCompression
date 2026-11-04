/**
 * 클립 편집 마무리 E2E: 우클릭 메뉴, 복제·복사·붙여넣기, 프레임 고정, 구간만 재생,
 * 화면에 맞추기, 표시 이름 바꾸기, 미리보기 전체 화면 버튼.
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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vslim-e2e-clipfin-'));
  const clip = path.join(workDir, '원본 클립.mp4');
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

test('새 프로젝트에 클립을 넣고 우클릭 메뉴를 열었다 닫는다', async () => {
  await page.getByRole('button', { name: '영상 편집' }).click();
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('button', { name: '클립 추가' }).click();
  const items = page.getByRole('list', { name: '타임라인' }).getByRole('listitem');
  await expect(items).toHaveCount(1, { timeout: 30_000 });
  await items.first().click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '클립 메뉴' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '프레임 고정' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('Ctrl+D 로 복제하고 Ctrl+C·Ctrl+V 로 붙여넣는다', async () => {
  const items = page.getByRole('list', { name: '타임라인' }).getByRole('listitem');
  await items.first().click();
  await page.keyboard.press('Control+d');
  await expect(items).toHaveCount(2);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(items).toHaveCount(3);
  await page.getByRole('button', { name: '실행 취소' }).click();
  await expect(items).toHaveCount(2);
});

test('재생 헤드에서 프레임 고정을 하면 세 조각이 되고, 고정 조각은 소리 없이 멈춘다', async () => {
  const items = page.getByRole('list', { name: '타임라인' }).getByRole('listitem');
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowRight');
  await items.first().click();
  await page.keyboard.press('f');
  await expect(items).toHaveCount(4);
  await expect(page.getByText(/· 고정/).first()).toBeVisible();
});

test('선택 구간만 재생하고, 화면에 맞추고, 이름을 바꾸고, 전체 화면 버튼이 있다', async () => {
  const items = page.getByRole('list', { name: '타임라인' }).getByRole('listitem');
  const zoom = page.getByRole('slider', { name: '타임라인 확대' });
  const before = await zoom.inputValue();
  await page.getByRole('button', { name: '화면에 맞추기' }).click();
  await expect.poll(async () => zoom.inputValue()).not.toBe(before);

  await expect(page.getByRole('button', { name: '미리보기 전체 화면' })).toBeVisible();

  // 이름 바꾸기 (속성 패널)
  await items.first().click();
  const name = page.getByRole('textbox', { name: '표시 이름' });
  await name.fill('인트로');
  await expect(items.first()).toContainText('인트로');
  // 입력칸에 초점이 있으면 단축키가 동작하지 않으므로 초점을 푼다
  await page.getByRole('button', { name: '화면에 맞추기' }).focus();

  // 0~1초 구간을 골라 그 구간만 재생: 1초에서 멈추고 재생 버튼으로 돌아온다
  await page.keyboard.press('Home');
  await page.keyboard.press('i');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('o');
  await expect(page.getByRole('button', { name: '선택 구간만 재생' })).toBeEnabled();
  await page.getByRole('button', { name: '선택 구간만 재생' }).click();
  await expect(page.getByTestId('timeline-preview')).toBeVisible();
  await expect(page.getByRole('button', { name: '미리보기 재생' })).toBeVisible({
    timeout: 20_000,
  });
  const slider = page.getByRole('slider', { name: '재생 헤드' });
  expect(Number(await slider.inputValue())).toBeLessThan(1.6);
});
