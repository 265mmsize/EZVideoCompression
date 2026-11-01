/**
 * 플레이어 키보드 매핑과 편집 도구 순수 로직 검증
 */
import { describe, expect, it } from 'vitest';
import { FRAME_STEP_SEC, playerAction } from '../../src/renderer/library/playerMath';

describe('플레이어 키보드 동작', () => {
  it('재생·탐색·배속 키를 동작으로 바꾼다', () => {
    expect(playerAction(' ', false, false)).toEqual({ type: 'toggle' });
    expect(playerAction('k', false, false)).toEqual({ type: 'toggle' });
    expect(playerAction('ArrowLeft', false, false)).toEqual({ type: 'seek', deltaSec: -3 });
    expect(playerAction('ArrowRight', true, false)).toEqual({ type: 'seek', deltaSec: 10 });
    expect(playerAction('.', false, false)).toEqual({ type: 'frame', dir: 1 });
    expect(playerAction('z', false, false)).toEqual({ type: 'rateReset' });
    expect(playerAction('C', false, false)).toEqual({ type: 'rate', dir: 1 });
  });

  it('구간·회전 키와 Ctrl 조합을 구분한다', () => {
    expect(playerAction('[', false, false)).toEqual({ type: 'markA' });
    expect(playerAction(']', false, false)).toEqual({ type: 'markB' });
    expect(playerAction('l', false, false)).toEqual({ type: 'loop' });
    expect(playerAction('r', false, false)).toEqual({ type: 'rotate' });
    expect(playerAction('h', false, false)).toEqual({ type: 'flipH' });
    expect(playerAction('v', false, false)).toEqual({ type: 'flipV' });
    // Ctrl 이 들어가면 브라우저 단축키와 겹치므로 처리하지 않는다
    expect(playerAction('c', false, true)).toBeNull();
    expect(playerAction('q', false, false)).toBeNull();
  });

  it('프레임 한 칸은 30fps 기준 1/30초다', () => {
    expect(FRAME_STEP_SEC).toBeCloseTo(0.0333, 3);
  });
});
