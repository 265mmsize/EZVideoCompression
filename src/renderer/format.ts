/** 화면 표시용 포맷터. 용량 단위는 MiB(1,048,576 바이트)를 기준으로 하고 화면에 MB 로 표기한다. */
const MIB = 1024 * 1024;
const GIB = MIB * 1024;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '-';
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GB`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '알 수 없음';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(r)}` : `${String(m)}:${pad(r)}`;
}

/** 남은 시간 추정. "약"을 붙여 확정 값이 아님을 드러낸다. */
export function formatEta(sec: number | null): string {
  if (sec === null) return '계산 중';
  if (sec < 60) return `약 ${String(Math.max(1, Math.round(sec)))}초 남음`;
  return `약 ${String(Math.round(sec / 60))}분 남음`;
}

export function formatPercent(ratio: number | null): string {
  return ratio === null ? '' : `${String(Math.floor(ratio * 100))}%`;
}

export function formatSavings(ratio: number | null): string {
  if (ratio === null) return '-';
  const pct = (Math.abs(ratio) * 100).toFixed(1);
  return ratio >= 0 ? `${pct}% 감소` : `${pct}% 증가`;
}
