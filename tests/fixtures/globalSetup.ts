/**
 * Vitest 전역 설정: 테스트 실행 전에 합성 픽스처를 생성한다.
 * 픽스처는 재현 가능하며 이미 있으면 건너뛴다.
 */
import { generateAll, DEFAULT_FIXTURE_DIR } from './generate';

export default function setup(): void {
  generateAll(DEFAULT_FIXTURE_DIR);
}
