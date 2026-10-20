import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // 통합 테스트는 실제 FFmpeg 를 실행하므로 타임아웃을 넉넉히 둔다.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // 픽스처 생성과 FFmpeg 실행이 파일 시스템을 공유하므로 순차 실행한다.
    fileParallelism: false,
    globalSetup: ['tests/fixtures/globalSetup.ts'],
  },
});
