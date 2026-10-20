import type { ReactNode } from 'react';
import type { JobStatus, SupportLevel } from '../../shared/types/domain';
import { ERROR_CATALOG, ERROR_CODES, type ErrorCode } from '../../shared/types/errors';

function isErrorCode(code: string): code is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(code);
}

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: '대기열',
  probing: '분석 준비',
  analyzing: '분석 중',
  ready: '준비됨',
  encoding: '인코딩 중',
  validating: '검증 중',
  completed: '완료',
  no_savings: '크기 증가',
  failed: '실패',
  cancelling: '취소 중',
  cancelled: '취소됨',
  interrupted: '중단됨',
};

const STATUS_TONE: Record<JobStatus, string> = {
  queued: 'text-[var(--c-info)]',
  probing: 'text-[var(--c-muted)]',
  analyzing: 'text-[var(--c-muted)]',
  ready: 'text-[var(--c-text)]',
  encoding: 'text-[var(--c-accent)]',
  validating: 'text-[var(--c-accent)]',
  completed: 'text-[var(--c-ok)]',
  no_savings: 'text-[var(--c-warn)]',
  failed: 'text-[var(--c-danger)]',
  cancelling: 'text-[var(--c-warn)]',
  cancelled: 'text-[var(--c-muted)]',
  interrupted: 'text-[var(--c-warn)]',
};

export function StatusBadge({ status }: { status: JobStatus }): ReactNode {
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${STATUS_TONE[status]}`}>
      <span aria-hidden="true">●</span>
      {STATUS_LABEL[status]}
    </span>
  );
}

export function SupportBadge({ level }: { level: SupportLevel }): ReactNode {
  const map: Record<SupportLevel, { text: string; cls: string }> = {
    supported: { text: '지원', cls: 'border-[var(--c-ok)] text-[var(--c-ok)]' },
    limited: { text: '제한 있음', cls: 'border-[var(--c-warn)] text-[var(--c-warn)]' },
    blocked: { text: '처리 차단', cls: 'border-[var(--c-danger)] text-[var(--c-danger)]' },
  };
  const m = map[level];
  return <span className={`rounded border px-1.5 py-0.5 text-xs ${m.cls}`}>{m.text}</span>;
}

export function ProgressBar({ ratio, label }: { ratio: number | null; label: string }): ReactNode {
  if (ratio === null) {
    // 길이를 모르면 불확정 상태: 채워지는 양을 표시하지 않는다
    return (
      <div
        role="progressbar"
        aria-label={label}
        aria-busy="true"
        className="h-2 w-full overflow-hidden rounded bg-[var(--c-surface-2)]"
      >
        <div className="h-full w-1/3 animate-pulse rounded bg-[var(--c-accent)]" />
      </div>
    );
  }
  const pct = Math.round(ratio * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-2 w-full overflow-hidden rounded bg-[var(--c-surface-2)]"
    >
      <div
        className="h-full rounded bg-[var(--c-accent)] transition-[width] duration-300"
        style={{ width: `${String(pct)}%` }}
      />
    </div>
  );
}

/** 오류 코드를 원인과 해결 방법으로 펼쳐 보여준다. 기술 상세는 접어서 제공한다. */
export function ErrorBlock({
  code,
  detail,
}: {
  code: string | null;
  detail: string | null;
}): ReactNode {
  if (!code) return null;
  const info = isErrorCode(code) ? ERROR_CATALOG[code] : ERROR_CATALOG.UNKNOWN;
  return (
    <div
      role="alert"
      className="rounded-md border border-[var(--c-danger)] bg-[var(--c-surface)] p-3 text-sm"
    >
      <p className="font-semibold text-[var(--c-danger)]">{info.title}</p>
      <p className="mt-1">원인: {info.cause}</p>
      <p className="mt-1">해결: {info.action}</p>
      {detail && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[var(--c-muted)]">기술 상세</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--c-surface-2)] p-2 text-xs">
            {detail}
          </pre>
        </details>
      )}
    </div>
  );
}

export function Button(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'ghost' | 'danger';
  },
): ReactNode {
  const { variant = 'ghost', className = '', ...rest } = props;
  const base = 'rounded-md px-3 py-1.5 text-sm font-medium border transition-colors';
  const styles = {
    primary: 'bg-[var(--c-accent)] text-[var(--c-accent-text)] border-transparent hover:opacity-90',
    ghost:
      'bg-[var(--c-surface)] text-[var(--c-text)] border-[var(--c-border)] hover:bg-[var(--c-surface-2)]',
    danger:
      'bg-[var(--c-surface)] text-[var(--c-danger)] border-[var(--c-danger)] hover:bg-[var(--c-surface-2)]',
  }[variant];
  return <button type="button" className={`${base} ${styles} ${className}`} {...rest} />;
}
