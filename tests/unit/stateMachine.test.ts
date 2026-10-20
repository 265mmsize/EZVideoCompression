import { describe, expect, it } from 'vitest';
import { JOB_STATUSES, JOB_TRANSITIONS, DELETABLE_STATUSES } from '../../src/shared/types/domain';
import { assertTransition, canTransition } from '../../src/main/services/JobStateMachine';

describe('작업 상태 전이표', () => {
  it('모든 상태가 전이표에 정의되어 있다', () => {
    for (const s of JOB_STATUSES) expect(JOB_TRANSITIONS[s]).toBeDefined();
  });

  it('정상 흐름을 허용한다: probing → analyzing → ready → queued → encoding → validating → completed', () => {
    const flow = [
      'probing',
      'analyzing',
      'ready',
      'queued',
      'encoding',
      'validating',
      'completed',
    ] as const;
    for (let i = 0; i < flow.length - 1; i++) {
      expect(canTransition(flow[i]!, flow[i + 1]!)).toBe(true);
    }
  });

  it('완료 상태에서 바로 인코딩으로 가는 것은 거부한다 (재실행은 probing 부터)', () => {
    expect(canTransition('completed', 'encoding')).toBe(false);
    expect(() => assertTransition('completed', 'encoding')).toThrow();
    expect(canTransition('completed', 'probing')).toBe(true);
  });

  it('취소는 cancelling 을 거쳐 cancelled 로만 끝난다', () => {
    expect(canTransition('encoding', 'cancelled')).toBe(false);
    expect(canTransition('encoding', 'cancelling')).toBe(true);
    expect(canTransition('cancelling', 'cancelled')).toBe(true);
    expect(canTransition('cancelling', 'interrupted')).toBe(false);
  });

  it('삭제 가능 상태에는 실행 중 상태가 포함되지 않는다', () => {
    for (const s of ['encoding', 'validating', 'cancelling', 'probing', 'analyzing'] as const) {
      expect(DELETABLE_STATUSES).not.toContain(s);
    }
  });
});
