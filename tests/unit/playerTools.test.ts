/**
 * 플레이어 보기 도구와 편집 실행 취소의 순수 로직 검증
 */
import { describe, expect, it } from 'vitest';
import {
  FIT_VIEW,
  clampView,
  loopBackTarget,
  normalizeLoop,
  panBy,
  stepRate,
  zoomAt,
} from '../../src/renderer/library/playerMath';
import {
  COALESCE_MS,
  emptyHistory,
  recordChange,
  redo,
  undo,
} from '../../src/renderer/pages/historyStack';

describe('구간 반복', () => {
  it('한쪽만 찍혔거나 너무 짧은 구간은 무효, 뒤집힌 구간은 바로잡고 길이를 넘지 않게 자른다', () => {
    expect(normalizeLoop(null, 5, 10)).toBeNull();
    expect(normalizeLoop(3, 3.1, 10)).toBeNull();
    expect(normalizeLoop(8, 2, 10)).toEqual({ startSec: 2, endSec: 8 });
    expect(normalizeLoop(2, 99, 10)).toEqual({ startSec: 2, endSec: 10 });
  });

  it('재생 위치가 끝에 닿으면 시작으로 되돌린다', () => {
    const r = { startSec: 2, endSec: 5 };
    expect(loopBackTarget(4.9, r)).toBeNull();
    expect(loopBackTarget(4.96, r)).toBe(2);
    expect(loopBackTarget(6, r)).toBe(2);
    expect(loopBackTarget(4.96, null)).toBeNull();
  });

  it('재생 속도는 단계별로만 움직이고 끝에서 머문다', () => {
    expect(stepRate(1, 1)).toBe(1.25);
    expect(stepRate(2, 1)).toBe(3);
    expect(stepRate(4, 1)).toBe(4); // 최대 4배에서 머문다
    expect(stepRate(0.25, -1)).toBe(0.25);
    expect(stepRate(0.5, -1)).toBe(0.25);
    expect(stepRate(1.25, -1)).toBe(1);
    expect(stepRate(1.3, 1)).toBe(1.25); // 목록에 없는 값은 1배 기준으로 계산
  });
});

describe('확대·이동 보기', () => {
  it('배율 1 이하는 맞춤으로 돌아가고, 최대 8배를 넘지 않는다', () => {
    expect(clampView({ scale: 0.5, tx: -10, ty: -10 }, 100, 100)).toEqual(FIT_VIEW);
    expect(clampView({ scale: 20, tx: 0, ty: 0 }, 100, 100).scale).toBe(8);
  });

  it('이동은 이미지가 요소를 덮는 범위 안에서만 된다', () => {
    const v = clampView({ scale: 2, tx: 50, ty: -500 }, 100, 100);
    expect(v.tx).toBe(0);
    expect(v.ty).toBe(-100);
    expect(panBy({ scale: 2, tx: 0, ty: 0 }, -30, -30, 100, 100)).toEqual({
      scale: 2,
      tx: -30,
      ty: -30,
    });
  });

  it('커서 위치는 확대 전후에 같은 이미지 점을 가리킨다', () => {
    const w = 200;
    const h = 100;
    const before = { scale: 1, tx: 0, ty: 0 };
    const cx = 50;
    const cy = 25;
    const after = zoomAt(before, 2, cx, cy, w, h);
    expect(after.scale).toBe(2);
    // 커서가 가리키는 원본 좌표: (cx - tx) / scale
    expect((cx - after.tx) / after.scale).toBeCloseTo(cx / 1, 6);
    expect((cy - after.ty) / after.scale).toBeCloseTo(cy / 1, 6);
  });
});

describe('편집 실행 취소 스택', () => {
  it('변경 전 상태를 쌓고 실행 취소·다시 실행이 순서대로 된다', () => {
    let h = emptyHistory<number>();
    h = recordChange(h, 1, 0, null); // 1 → 2
    h = recordChange(h, 2, 10_000, null); // 2 → 3
    const u1 = undo(h, 3);
    expect(u1?.state).toBe(2);
    const u2 = undo(u1!.history, 2);
    expect(u2?.state).toBe(1);
    expect(undo(u2!.history, 1)).toBeNull();
    const r1 = redo(u2!.history, 1);
    expect(r1?.state).toBe(2);
    expect(redo(r1!.history, 2)?.state).toBe(3);
  });

  it('같은 키의 짧은 간격 변경은 한 단계로 묶고, 키가 다르거나 null 이면 묶지 않는다', () => {
    let h = emptyHistory<number>();
    h = recordChange(h, 0, 1_000, 'clip:a'); // 첫 변경
    h = recordChange(h, 1, 1_000 + COALESCE_MS - 100, 'clip:a'); // 같은 키, 묶임
    expect(h.past).toEqual([0]);
    h = recordChange(h, 2, 1_000 + COALESCE_MS - 50, null); // 추가·분할은 묶이지 않는다
    h = recordChange(h, 3, 1_000 + COALESCE_MS - 40, null);
    expect(h.past).toEqual([0, 2, 3]);
    expect(undo(h, 4)?.state).toBe(3);
  });

  it('추가 직후의 분할처럼 다른 변경은 시간이 가까워도 따로 취소된다', () => {
    let h = emptyHistory<string>();
    h = recordChange(h, 'empty', 0, null); // 클립 추가
    h = recordChange(h, 'one clip', 100, null); // 분할
    expect(undo(h, 'two clips')?.state).toBe('one clip');
  });

  it('새 변경이 생기면 다시 실행 목록은 사라진다', () => {
    let h = emptyHistory<number>();
    h = recordChange(h, 1, 0, null);
    const u = undo(h, 2)!;
    expect(u.history.future).toEqual([2]);
    const h2 = recordChange(u.history, 1, 10_000, null);
    expect(h2.future).toEqual([]);
  });

  it('실행 목록은 최대 100단계를 넘지 않는다', () => {
    let h = emptyHistory<number>();
    for (let i = 0; i < 150; i++) h = recordChange(h, i, i * 10_000, null);
    expect(h.past).toHaveLength(100);
    expect(h.past[0]).toBe(50);
  });
});
