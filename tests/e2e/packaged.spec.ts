/**
 * 패키지된 실행 파일 스모크 테스트. release/ 에 빌드 산출물이 있을 때만 실행한다.
 * 개발용 out/ 이 아니라 asar 로 묶인 실제 앱이 뜨는지 확인한다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

const exe = path.join(__dirname, '../../release/linux-unpacked/videoslim-desktop');
const available = fs.existsSync(exe);

test.skip(!available, 'release/linux-unpacked 가 없습니다 (npm run pack:linux-dir 먼저 실행)');

test('패키지된 앱이 asar 에서 렌더러를 로드하고 FFmpeg 상태를 표시한다', async () => {
  const app = await electron.launch({
    executablePath: exe,
    args: ['--no-sandbox', `--user-data-dir=${path.join(os.tmpdir(), 'vslim-packaged-userdata')}`],
    timeout: 60_000,
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'VideoSlim Desktop' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('FFmpeg 를 사용할 수 없어')).toHaveCount(0);
  } finally {
    await app.close();
    fs.rmSync(path.join(os.tmpdir(), 'vslim-packaged-userdata'), {
      recursive: true,
      force: true,
    });
  }
});
