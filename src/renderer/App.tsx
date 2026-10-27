import { useEffect, useState, type ReactNode } from 'react';
import { useAppStore } from './hooks/useAppStore';
import { ComparePage } from './pages/ComparePage';
import { HistoryPage } from './pages/HistoryPage';
import { JobsPage } from './pages/JobsPage';
import { SettingsPage } from './pages/SettingsPage';
import { LibraryPage } from './library/LibraryPage';
import { Button } from './components/ui';
import { recheckTools } from './actions';
import { errorText, notify, initStore } from './stores/appStore';

type Tab = 'library' | 'jobs' | 'compare' | 'history' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'library', label: '라이브러리' },
  { id: 'jobs', label: '작업 목록' },
  { id: 'compare', label: '비교' },
  { id: 'history', label: '이력' },
  { id: 'settings', label: '설정' },
];

export function App(): ReactNode {
  const [tab, setTab] = useState<Tab>('jobs');
  const [compareJobId, setCompareJobId] = useState<string | null>(null);
  const openCompare = (jobId: string): void => {
    setCompareJobId(jobId);
    setTab('compare');
  };
  const { ready, tools, settings, notice } = useAppStore();

  useEffect(() => {
    initStore().catch((err: unknown) => notify('error', `초기화 실패: ${errorText(err)}`));
  }, []);

  // 테마: 시스템 설정 또는 사용자 선택을 data-theme 속성으로 반영한다
  useEffect(() => {
    const root = document.documentElement;
    if (!settings || settings.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
  }, [settings]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-2">
        <h1 className="text-base font-bold">VideoSlim Desktop</h1>
        <nav aria-label="주 메뉴" className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => setTab(t.id)}
              className={`rounded px-3 py-1.5 text-sm ${tab === t.id ? 'bg-[var(--c-accent)] text-[var(--c-accent-text)]' : 'hover:bg-[var(--c-surface-2)]'}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <span className="ml-auto text-xs text-[var(--c-muted)]">
          오프라인 처리 · 원본은 수정되지 않습니다
        </span>
      </header>

      {tools && !tools.ready && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-[var(--c-danger)] bg-[var(--c-surface)] px-4 py-2 text-sm"
        >
          <span className="font-semibold text-[var(--c-danger)]">
            FFmpeg 를 사용할 수 없어 분석·압축을 시작할 수 없습니다.
          </span>
          <span className="text-[var(--c-muted)]">
            {tools.ffmpeg.error ?? tools.ffprobe.error} · 설정에서 경로를 지정하거나 앱을 다시
            설치하세요.
          </span>
          <Button onClick={() => void recheckTools()}>다시 확인</Button>
          <Button onClick={() => setTab('settings')}>설정 열기</Button>
        </div>
      )}

      {notice && (
        <div
          role="status"
          aria-live="polite"
          className={`border-b px-4 py-2 text-sm ${notice.kind === 'error' ? 'border-[var(--c-danger)] text-[var(--c-danger)]' : 'border-[var(--c-border)] text-[var(--c-muted)]'}`}
        >
          {notice.text}
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-auto">
        {!ready ? (
          <div className="p-6 text-[var(--c-muted)]">불러오는 중…</div>
        ) : tab === 'library' ? (
          <LibraryPage onCompare={openCompare} />
        ) : tab === 'jobs' ? (
          <JobsPage />
        ) : tab === 'compare' ? (
          <ComparePage key={compareJobId ?? 'none'} initialJobId={compareJobId} />
        ) : tab === 'history' ? (
          <HistoryPage />
        ) : (
          <SettingsPage />
        )}
      </main>
    </div>
  );
}
