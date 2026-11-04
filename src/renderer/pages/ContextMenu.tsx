/**
 * 작은 우클릭 메뉴. 바깥을 누르거나 Esc 를 누르면 닫힌다. 항목을 고르면 먼저 닫고 동작을 실행한다.
 */
import { useEffect, type ReactNode } from 'react';

export type MenuEntry =
  | { sep: true }
  | { label: string; hint?: string; disabled?: boolean; danger?: boolean; onSelect: () => void };

export function ContextMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}): ReactNode {
  useEffect(() => {
    const close = (): void => onClose();
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  return (
    <div
      role="menu"
      aria-label="클립 메뉴"
      className="fixed z-50 min-w-52 rounded border border-[var(--c-border)] bg-[var(--c-surface)] py-1 text-xs shadow-lg"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {entries.map((en, i) =>
        'sep' in en ? (
          <div key={`sep-${String(i)}`} className="my-1 border-t border-[var(--c-border)]" />
        ) : (
          <button
            key={en.label}
            type="button"
            role="menuitem"
            disabled={en.disabled}
            className={`flex w-full items-center justify-between gap-6 px-3 py-1 text-left hover:bg-[var(--c-surface-2)] disabled:opacity-40 ${en.danger ? 'text-[var(--c-danger)]' : ''}`}
            onClick={() => {
              onClose();
              en.onSelect();
            }}
          >
            <span>{en.label}</span>
            {en.hint && <span className="text-[var(--c-muted)]">{en.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
