/**
 * 플레이어 키보드 매핑 검증 (킹플레이어 도움말 기준)
 */
import { describe, expect, it } from 'vitest';
import {
  FRAME_STEP_SEC,
  VOLUME_STEP,
  playerAction,
  resumeStorageKey,
  shouldResume,
} from '../../src/renderer/library/playerMath';

describe('재생·탐색 키', () => {
  it('재생과 탐색', () => {
    expect(playerAction(' ', false, false)).toEqual({ type: 'toggle' });
    expect(playerAction('k', false, false)).toEqual({ type: 'toggle' });
    expect(playerAction('ArrowLeft', false, false)).toEqual({ type: 'seek', deltaSec: -3 });
    expect(playerAction('ArrowRight', true, false)).toEqual({ type: 'seek', deltaSec: 10 });
    expect(playerAction('ArrowRight', false, false, true)).toEqual({ type: 'seek', deltaSec: 60 });
    expect(playerAction('ArrowLeft', false, true)).toEqual({ type: 'frame', dir: -1 });
    expect(playerAction('ArrowRight', false, true)).toEqual({ type: 'frame', dir: 1 });
    expect(FRAME_STEP_SEC).toBeCloseTo(0.0333, 3);
  });

  it('쉼표와 마침표는 자막 싱크, 슬래시는 싱크 초기화', () => {
    expect(playerAction(',', false, false)).toEqual({ type: 'subSync', deltaSec: -0.5 });
    expect(playerAction('.', false, false)).toEqual({ type: 'subSync', deltaSec: 0.5 });
    expect(playerAction('/', false, false)).toEqual({ type: 'subReset' });
  });

  it('배속, 구간, 회전, 반전', () => {
    expect(playerAction('z', false, false)).toEqual({ type: 'rateReset' });
    expect(playerAction('C', false, false)).toEqual({ type: 'rate', dir: 1 });
    expect(playerAction('[', false, false)).toEqual({ type: 'markA' });
    expect(playerAction(']', false, false)).toEqual({ type: 'markB' });
    expect(playerAction('\\', false, false)).toEqual({ type: 'clearRange' });
    expect(playerAction('l', false, false)).toEqual({ type: 'loop' });
    expect(playerAction('r', false, false)).toEqual({ type: 'rotate', deltaDeg: 90 });
    expect(playerAction('q', false, false)).toEqual({ type: 'rotate', deltaDeg: -90 });
    expect(playerAction('h', false, false)).toEqual({ type: 'flipH' });
    expect(playerAction('v', false, false)).toEqual({ type: 'flipV' });
    expect(playerAction('Home', false, false)).toEqual({ type: 'home' });
  });

  it('볼륨, 음소거, 확대', () => {
    expect(playerAction('ArrowUp', false, false)).toEqual({ type: 'volume', delta: VOLUME_STEP });
    expect(playerAction('ArrowDown', false, false)).toEqual({
      type: 'volume',
      delta: -VOLUME_STEP,
    });
    expect(playerAction('m', false, false)).toEqual({ type: 'mute' });
    expect(playerAction('+', false, false)).toEqual({ type: 'zoom', dir: 1 });
    expect(playerAction('-', false, false)).toEqual({ type: 'zoom', dir: -1 });
    expect(playerAction('0', false, false)).toEqual({ type: 'zoomReset' });
  });

  it('책갈피, 자막 바꾸기, 항목 이동, 스크린샷, 컬러 피커', () => {
    expect(playerAction('b', false, false)).toEqual({ type: 'bookmark' });
    expect(playerAction('PageUp', true, false)).toEqual({ type: 'bookmarkStep', dir: -1 });
    expect(playerAction('PageDown', false, false)).toEqual({ type: 'step', dir: 1 });
    expect(playerAction('j', false, false)).toEqual({ type: 'subSwitch', dir: 1 });
    expect(playerAction('J', true, false)).toEqual({ type: 'subSwitch', dir: -1 });
    expect(playerAction('p', false, true)).toEqual({ type: 'screenshot' });
    expect(playerAction('i', false, false)).toEqual({ type: 'picker' });
  });

  it('Ctrl 과 Alt 조합은 다른 단축키와 겹치지 않도록 제한한다', () => {
    expect(playerAction('c', false, true)).toBeNull();
    expect(playerAction('q', false, false)).toEqual({ type: 'rotate', deltaDeg: -90 });
    expect(playerAction('x', false, true)).toBeNull();
  });
});

describe('이어보기 규칙', () => {
  it('3초 이상, 끝에서 5초 이상 남았을 때만 이어서 연다', () => {
    expect(shouldResume(null, 100)).toBe(false);
    expect(shouldResume(2, 100)).toBe(false);
    expect(shouldResume(42, 100)).toBe(true);
    expect(shouldResume(98, 100)).toBe(false);
    expect(shouldResume(42, null)).toBe(true);
    expect(resumeStorageKey('abc')).toBe('vslim.resume.abc');
  });
});
