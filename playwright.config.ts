import { defineConfig } from '@playwright/test';

// Electron E2E. 실제 빌드 산출물(out/)을 띄워 검증한다. 실행 전 `npm run build` 가 필요하다.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'off' },
});
