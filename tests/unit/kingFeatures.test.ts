/** 킹플레이어 키프레임 이동·창 항상 위 단축키, 키프레임 계산, .kcp 형식 검사 */
import { describe, expect, it } from 'vitest';
import { nextKeyframe, playerAction } from '../../src/renderer/library/playerMath';
import { kcpFileSchema } from '../../src/shared/schemas/ipc.schemas';

describe('키프레임 이동과 창 항상 위 단축키', () => {
  it('Ctrl+Shift+←/→ 는 키프레임 이동, Ctrl+←/→ 는 한 프레임', () => {
    expect(playerAction('ArrowLeft', true, true)).toEqual({ type: 'keyframe', dir: -1 });
    expect(playerAction('ArrowRight', true, true)).toEqual({ type: 'keyframe', dir: 1 });
    expect(playerAction('ArrowLeft', false, true)).toEqual({ type: 'frame', dir: -1 });
    expect(playerAction('ArrowRight', false, true)).toEqual({ type: 'frame', dir: 1 });
  });

  it('Ctrl+T 는 창 항상 위, 대소문자 모두 받는다', () => {
    expect(playerAction('t', false, true)).toEqual({ type: 'alwaysOnTop' });
    expect(playerAction('T', false, true)).toEqual({ type: 'alwaysOnTop' });
  });

  it('Shift 만 누른 ←/→ 는 기존대로 10초 이동', () => {
    expect(playerAction('ArrowLeft', true, false)).toEqual({ type: 'seek', deltaSec: -10 });
  });
});

describe('nextKeyframe', () => {
  const kf = [0, 0.5, 1, 1.5, 2];

  it('현재 시각 뒤·앞의 가장 가까운 키프레임을 고른다', () => {
    expect(nextKeyframe(kf, 0.7, 1)).toBe(1);
    expect(nextKeyframe(kf, 0.7, -1)).toBe(0.5);
  });

  it('키프레임 위에 있으면 그 키프레임을 건너뛴다 (오차 0.001초 안은 같은 것으로 본다)', () => {
    expect(nextKeyframe(kf, 1, 1)).toBe(1.5);
    expect(nextKeyframe(kf, 1, -1)).toBe(0.5);
    expect(nextKeyframe(kf, 1.0005, 1)).toBe(1.5);
  });

  it('목록이 정렬되어 있지 않아도 올바른 값을 고른다', () => {
    expect(nextKeyframe([2, 0, 1.5, 0.5], 0.7, 1)).toBe(1.5);
    expect(nextKeyframe([2, 0, 1.5, 0.5], 0.7, -1)).toBe(0.5);
  });

  it('끝을 넘으면 null, 목록이 비어 있으면 null, 잘못된 값은 무시한다', () => {
    expect(nextKeyframe(kf, 2, 1)).toBeNull();
    expect(nextKeyframe(kf, 0, -1)).toBeNull();
    expect(nextKeyframe([], 1, 1)).toBeNull();
    expect(nextKeyframe([Number.NaN, 3], 1, 1)).toBe(3);
  });
});

describe('.kcp 파일 형식 검사', () => {
  it('format 과 version 이 맞지 않으면 거부한다', () => {
    expect(kcpFileSchema.safeParse({ format: 'json', version: 1, project: {} }).success).toBe(
      false,
    );
    expect(kcpFileSchema.safeParse({ format: 'kcp', version: 2, project: {} }).success).toBe(false);
  });

  it('프로젝트 본문이 잘못되면 거부한다', () => {
    expect(
      kcpFileSchema.safeParse({ format: 'kcp', version: 1, project: { name: 123 } }).success,
    ).toBe(false);
  });
});
