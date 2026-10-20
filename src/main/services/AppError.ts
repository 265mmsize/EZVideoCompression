/**
 * 앱 내부 오류. 오류 코드와 기술 상세를 함께 담는다.
 * 사용자용 문구는 렌더러가 ERROR_CATALOG 에서 찾는다.
 */
import { ERROR_CODES, type AppErrorPayload, type ErrorCode } from '../../shared/types/errors';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | null;

  constructor(code: ErrorCode, detail?: string | null, options?: { cause?: unknown }) {
    super(`${code}${detail ? `: ${detail}` : ''}`, options);
    this.name = 'AppError';
    this.code = code;
    this.detail = detail ?? null;
  }

  toPayload(): AppErrorPayload {
    return { code: this.code, detail: this.detail };
  }

  static from(err: unknown): AppError {
    if (err instanceof AppError) return err;
    if (err instanceof Error) {
      return new AppError('UNKNOWN', `${err.name}: ${err.message}`, { cause: err });
    }
    return new AppError('UNKNOWN', String(err));
  }

  static isCode(value: unknown): value is ErrorCode {
    return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
  }
}
