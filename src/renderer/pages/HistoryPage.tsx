import { useEffect, useState, type ReactNode } from 'react';
import type { JobView } from '../../shared/types/domain';
import { call } from '../api';
import { errorText, notify } from '../stores/appStore';
import { formatBytes, formatSavings } from '../format';
import { Button, StatusBadge } from '../components/ui';
import { removeJob, showInFolder } from '../actions';
import { useAppStore } from '../hooks/useAppStore';

const PAGE = 50;

export function HistoryPage(): ReactNode {
  const [items, setItems] = useState<JobView[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  // 목록 화면의 변경(완료 등)이 이력에도 반영되도록 작업 수 변화를 관찰한다
  const { jobs } = useAppStore();
  const version = jobs.map((j) => `${j.id}:${j.status}`).join('|');

  useEffect(() => {
    call('history:list', { limit: PAGE, offset })
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((err: unknown) => notify('error', `이력 불러오기 실패: ${errorText(err)}`));
  }, [offset, version]);

  const onDelete = async (id: string): Promise<void> => {
    if (
      !window.confirm(
        '이 이력 기록을 삭제합니다. 원본과 결과 파일은 삭제되지 않습니다. 계속할까요?',
      )
    )
      return;
    await removeJob(id);
    setItems((prev) => prev.filter((j) => j.id !== id));
  };

  return (
    <div className="space-y-3 p-4">
      <h1 className="text-lg font-semibold">이력</h1>
      <p className="text-sm text-[var(--c-muted)]">
        완료·실패·취소된 작업의 기록입니다. 기록을 지워도 파일은 그대로 남습니다.
      </p>
      <div className="overflow-x-auto rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)]">
        <table className="w-full min-w-[860px] text-left text-sm">
          <caption className="sr-only">작업 이력</caption>
          <thead className="bg-[var(--c-surface-2)] text-[var(--c-muted)]">
            <tr>
              <th scope="col" className="px-3 py-2">
                파일명
              </th>
              <th scope="col" className="px-3 py-2">
                원본
              </th>
              <th scope="col" className="px-3 py-2">
                결과
              </th>
              <th scope="col" className="px-3 py-2">
                절감률
              </th>
              <th scope="col" className="px-3 py-2">
                상태
              </th>
              <th scope="col" className="px-3 py-2">
                완료 시각
              </th>
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">작업</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-[var(--c-muted)]">
                  이력이 없습니다.
                </td>
              </tr>
            )}
            {items.map((j: JobView) => (
              <tr key={j.id} className="border-t border-[var(--c-border)]">
                <td className="px-3 py-2">
                  <span className="block max-w-[260px] truncate" title={j.inputPath}>
                    {j.fileName}
                  </span>
                </td>
                <td className="px-3 py-2">{formatBytes(j.inputSizeBytes)}</td>
                <td className="px-3 py-2">{formatBytes(j.outputSizeBytes)}</td>
                <td className="px-3 py-2">{formatSavings(j.savingsRatio)}</td>
                <td className="px-3 py-2">
                  <StatusBadge status={j.status} />
                  {j.errorCode && (
                    <div className="text-xs text-[var(--c-muted)]">{j.errorCode}</div>
                  )}
                </td>
                <td className="px-3 py-2">
                  {j.finishedAt ? new Date(j.finishedAt).toLocaleString('ko-KR') : '-'}
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    {j.outputPath && (
                      <Button onClick={() => void showInFolder(j.outputPath as string)}>
                        결과 위치
                      </Button>
                    )}
                    <Button onClick={() => void showInFolder(j.inputPath)}>원본 위치</Button>
                    <Button variant="danger" onClick={() => void onDelete(j.id)}>
                      기록 삭제
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          이전
        </Button>
        <span>
          {total === 0 ? 0 : offset + 1}–{Math.min(total, offset + PAGE)} / {total}
        </span>
        <Button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
          다음
        </Button>
      </div>
    </div>
  );
}
