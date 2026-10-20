/**
 * 작업 상태 전이 검사. 허용되지 않은 전이는 예외로 막는다.
 * 전이표 자체는 shared/types/domain.ts 의 JOB_TRANSITIONS 가 원본이다.
 */
import { JOB_TRANSITIONS, type JobStatus } from '../../shared/types/domain';
import { AppError } from './AppError';

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError('INVALID_STATE', `${from} → ${to} 전이는 허용되지 않습니다`);
  }
}

/** 실행 슬롯을 점유하는 상태인지 (동시 실행 1개 보장에 사용) */
export function occupiesEncodeSlot(status: JobStatus): boolean {
  return status === 'encoding' || status === 'validating' || status === 'cancelling';
}
