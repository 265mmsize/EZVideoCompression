import type { ReactNode } from 'react';
import type { JobView } from '../../shared/types/domain';
import { MODE_LABELS } from '../../shared/contracts/ipc';
import { formatBytes, formatDuration, formatEta, formatPercent, formatSavings } from '../format';
import { Button, ProgressBar, StatusBadge } from './ui';
import { cancelJob, moveJob, removeJob, retryJob, startQueue, unqueueJob } from '../actions';

interface Props {
  jobs: JobView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const BUSY = new Set(['encoding', 'validating', 'cancelling']);

export function JobTable({ jobs, selectedId, onSelect }: Props): ReactNode {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)]">
      <table className="w-full min-w-[980px] border-collapse text-left text-sm">
        <caption className="sr-only">영상 작업 목록</caption>
        <thead className="bg-[var(--c-surface-2)] text-[var(--c-muted)]">
          <tr>
            <th scope="col" className="px-3 py-2">
              파일명
            </th>
            <th scope="col" className="px-3 py-2">
              원본 크기
            </th>
            <th scope="col" className="px-3 py-2">
              길이
            </th>
            <th scope="col" className="px-3 py-2">
              해상도·코덱
            </th>
            <th scope="col" className="px-3 py-2">
              모드
            </th>
            <th scope="col" className="px-3 py-2">
              예상 크기
            </th>
            <th scope="col" className="px-3 py-2">
              진행률
            </th>
            <th scope="col" className="px-3 py-2">
              상태
            </th>
            <th scope="col" className="px-3 py-2">
              결과 크기
            </th>
            <th scope="col" className="px-3 py-2">
              절감률
            </th>
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">작업</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {jobs.length === 0 && (
            <tr>
              <td colSpan={11} className="px-3 py-10 text-center text-[var(--c-muted)]">
                파일을 추가하거나 여기에 영상을 끌어다 놓으세요.
              </td>
            </tr>
          )}
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} selected={job.id === selectedId} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobRow({
  job,
  selected,
  onSelect,
}: {
  job: JobView;
  selected: boolean;
  onSelect: (id: string) => void;
}): ReactNode {
  const probe = job.probe;
  const primary = job.analysis?.primaryVideoIndex;
  const video = probe?.streams.find((s) => s.index === primary);
  const res = video?.width && video.height ? `${String(video.width)}×${String(video.height)}` : '-';
  const codec = video?.codecName ?? '-';
  const expected = job.analysis?.expected;
  const expectedText =
    expected?.kind === 'unknown'
      ? '알 수 없음'
      : expected?.maxBytes
        ? `≤ ${formatBytes(expected.maxBytes)}`
        : expected?.minBytes
          ? formatBytes(expected.minBytes)
          : '-';
  const estimate = job.analysis?.expected.kind === 'estimated' ? '(추정)' : '';
  const busy = BUSY.has(job.status);

  return (
    <tr
      className={`border-t border-[var(--c-border)] ${selected ? 'bg-[var(--c-surface-2)]' : ''}`}
      aria-selected={selected}
    >
      <td className="px-3 py-2">
        <button
          type="button"
          onClick={() => onSelect(job.id)}
          className="max-w-[260px] truncate text-left font-medium text-[var(--c-accent)] underline-offset-2 hover:underline"
          title={job.inputPath}
        >
          {job.fileName}
        </button>
        {job.queuePosition > 0 && (
          <span className="ml-2 text-xs text-[var(--c-muted)]">#{job.queuePosition}</span>
        )}
      </td>
      <td className="px-3 py-2">{formatBytes(job.inputSizeBytes)}</td>
      <td className="px-3 py-2">{formatDuration(probe?.durationSec.value ?? null)}</td>
      <td className="px-3 py-2">
        {res} · {codec}
      </td>
      <td className="px-3 py-2">{MODE_LABELS[job.settings.mode]}</td>
      <td className="px-3 py-2">
        {expectedText} {estimate}
      </td>
      <td className="w-40 px-3 py-2">
        {busy ? (
          <div className="space-y-1">
            <ProgressBar ratio={job.progress.ratio} label={`${job.fileName} 진행률`} />
            <div className="text-xs text-[var(--c-muted)]">
              {job.progress.ratio === null
                ? '길이를 알 수 없어 진행률을 표시할 수 없습니다'
                : `${formatPercent(job.progress.ratio)} · ${formatEta(job.progress.etaSec)}`}
            </div>
          </div>
        ) : (
          <span className="text-[var(--c-muted)]">-</span>
        )}
      </td>
      <td className="px-3 py-2">
        <StatusBadge status={job.status} />
        {job.statusMessage && (
          <div className="mt-0.5 max-w-[220px] text-xs text-[var(--c-muted)]">
            {job.statusMessage}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        {job.outputSizeBytes !== null ? formatBytes(job.outputSizeBytes) : '-'}
      </td>
      <td className="px-3 py-2">{formatSavings(job.savingsRatio)}</td>
      <td className="px-3 py-2">
        <RowActions job={job} />
      </td>
    </tr>
  );
}

function RowActions({ job }: { job: JobView }): ReactNode {
  const s = job.status;
  return (
    <div className="flex flex-wrap gap-1">
      {(s === 'ready' || s === 'queued') && (
        <>
          {s === 'ready' && (
            <Button
              onClick={() => void startQueue([job.id])}
              disabled={job.analysis?.support === 'blocked'}
              aria-label={`${job.fileName} 시작`}
            >
              시작
            </Button>
          )}
          {s === 'queued' && (
            <Button
              onClick={() => void unqueueJob(job.id)}
              aria-label={`${job.fileName} 대기열에서 빼기`}
            >
              대기 해제
            </Button>
          )}
          <Button onClick={() => void moveJob(job.id, 'up')} aria-label={`${job.fileName} 위로`}>
            ↑
          </Button>
          <Button
            onClick={() => void moveJob(job.id, 'down')}
            aria-label={`${job.fileName} 아래로`}
          >
            ↓
          </Button>
        </>
      )}
      {s === 'encoding' || s === 'validating' ? (
        <Button
          variant="danger"
          onClick={() => void cancelJob(job.id)}
          aria-label={`${job.fileName} 취소`}
        >
          취소
        </Button>
      ) : null}
      {['failed', 'cancelled', 'interrupted', 'completed', 'no_savings'].includes(s) && (
        <Button onClick={() => void retryJob(job.id)} aria-label={`${job.fileName} 다시 처리`}>
          다시 처리
        </Button>
      )}
      {[
        'ready',
        'queued',
        'completed',
        'no_savings',
        'failed',
        'cancelled',
        'interrupted',
      ].includes(s) && (
        <Button onClick={() => void removeJob(job.id)} aria-label={`${job.fileName} 목록에서 제거`}>
          제거
        </Button>
      )}
    </div>
  );
}
