import { useState, type DragEvent, type ReactNode } from 'react';
import { useAppStore } from '../hooks/useAppStore';
import { JobTable } from '../components/JobTable';
import { JobDetail } from '../components/JobDetail';
import { Button } from '../components/ui';
import { addDropped, addFiles, addFolder, setPaused, startQueue } from '../actions';
import { pathOf } from '../api';

export function JobsPage(): ReactNode {
  const { jobs, queue, settings } = useAppStore();
  const [includeSub, setIncludeSub] = useState<boolean>(
    settings?.includeSubfoldersDefault ?? false,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const selected = jobs.find((j) => j.id === selectedId) ?? null;
  const readyCount = jobs.filter(
    (j) => j.status === 'ready' && j.analysis?.support !== 'blocked',
  ).length;
  const queuedCount = jobs.filter((j) => j.status === 'queued').length;

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    const paths: string[] = [];
    for (const f of Array.from(e.dataTransfer.files)) {
      try {
        paths.push(pathOf(f));
      } catch {
        // 경로를 얻을 수 없는 항목은 건너뛴다
      }
    }
    if (paths.length > 0) void addDropped(paths, includeSub);
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void addFiles()}>
          파일 추가
        </Button>
        <Button onClick={() => void addFolder(includeSub)}>폴더 추가</Button>
        <label className="flex items-center gap-1 text-sm">
          <input
            type="checkbox"
            checked={includeSub}
            onChange={(e) => setIncludeSub(e.target.checked)}
          />
          하위 폴더 포함
        </label>
        <span className="mx-2 h-5 w-px bg-[var(--c-border)]" aria-hidden="true" />
        <Button onClick={() => void startQueue(null)} disabled={readyCount === 0}>
          준비된 작업 대기열에 넣기 ({readyCount})
        </Button>
        <Button onClick={() => void setPaused(!queue.paused)}>
          {queue.paused ? '대기열 재개' : '다음 작업부터 중지'}
        </Button>
        <span className="text-xs text-[var(--c-muted)]" aria-live="polite">
          {queue.paused
            ? '일시정지: 현재 작업은 끝까지 진행되며, 다음 작업은 시작되지 않습니다.'
            : queue.runningJobId
              ? '인코딩 중 (동시 1개)'
              : `대기 ${String(queuedCount)}개`}
        </span>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`rounded-lg border-2 border-dashed p-3 text-center text-sm text-[var(--c-muted)] ${dragging ? 'border-[var(--c-accent)]' : 'border-[var(--c-border)]'}`}
        aria-label="영상 끌어다 놓는 영역"
      >
        여기에 영상 파일이나 폴더를 끌어다 놓으면 목록에 추가됩니다. 원본 파일은 수정되지 않습니다.
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-w-0 flex-1 overflow-auto">
          <JobTable jobs={jobs} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
        {selected && (
          <JobDetail key={selected.id} job={selected} onClose={() => setSelectedId(null)} />
        )}
      </div>
    </div>
  );
}
