import { useEffect, useState, type ReactNode } from 'react';
import type { AppSettings, JobSettings } from '../../shared/types/domain';
import {
  COMPRESSION_MODES,
  OUTPUT_CONTAINERS,
  PRESETS,
  VIDEO_CODECS,
} from '../../shared/types/domain';
import { MODE_LABELS } from '../../shared/contracts/ipc';
import { useAppStore } from '../hooks/useAppStore';
import { exportLogs, recheckTools, saveAppSettings } from '../actions';
import { Button } from '../components/ui';
import { libraryApi } from '../library/libraryActions';
import { formatBytes } from '../format';
import type { CacheStats } from '../../shared/types/domain';

export function SettingsPage(): ReactNode {
  const { settings, tools } = useAppStore();
  const [maskPaths, setMaskPaths] = useState(true);
  if (!settings) return <div className="p-4">설정을 불러오는 중입니다…</div>;

  const save = (patch: Partial<AppSettings>): void => {
    void saveAppSettings(patch);
  };
  const saveDefaults = (patch: Partial<JobSettings>): void => {
    void saveAppSettings({ defaults: { ...settings.defaults, ...patch } });
  };

  return (
    <div className="max-w-3xl space-y-6 p-4">
      <h1 className="text-lg font-semibold">설정</h1>

      <Group title="화면">
        <label className="flex items-center gap-2 text-sm">
          테마
          <select
            className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
            value={settings.theme}
            onChange={(e) => save({ theme: e.target.value as AppSettings['theme'] })}
          >
            <option value="system">시스템 설정 따름</option>
            <option value="light">밝게</option>
            <option value="dark">어둡게</option>
          </select>
        </label>
      </Group>

      <Group title="FFmpeg 도구">
        <ToolLine label="ffmpeg" info={tools?.ffmpeg} />
        <ToolLine label="ffprobe" info={tools?.ffprobe} />
        <p className="text-sm">
          사용 가능한 소프트웨어 인코더:{' '}
          {tools?.encoders.length ? tools.encoders.join(', ') : '없음'}
        </p>
        <div className="space-y-1 text-sm">
          <p className="font-medium">하드웨어 인코더 (테스트 인코딩 통과 시에만 사용 가능)</p>
          <ul className="space-y-0.5 text-xs">
            {(tools?.hardwareEncoders ?? []).map((h) => (
              <li key={h.name}>
                {h.name}:{' '}
                {h.available ? (
                  <span className="text-[var(--c-ok)]">사용 가능</span>
                ) : (
                  <span className="text-[var(--c-muted)]">사용 안 함 — {h.reason}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--c-muted)]">
            하드웨어 인코더는 장치별로 검증되지 않았습니다. 실패하면 자동으로 CPU 인코더로 대체하고
            결과에 기록합니다.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.fastUseHardware}
            onChange={(e) => save({ fastUseHardware: e.target.checked })}
          />
          빠른 압축에서 사용 가능한 하드웨어 인코더를 먼저 사용
        </label>
        <PathField
          label="ffmpeg 경로 (비우면 자동 탐색)"
          value={settings.ffmpegPath ?? ''}
          onSave={(v) => save({ ffmpegPath: v === '' ? null : v })}
        />
        <PathField
          label="ffprobe 경로 (비우면 자동 탐색)"
          value={settings.ffprobePath ?? ''}
          onSave={(v) => save({ ffprobePath: v === '' ? null : v })}
        />
        <Button onClick={() => void recheckTools()}>다시 확인</Button>
      </Group>

      <Group title="새 작업 기본값">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="flex flex-col gap-1">
            모드
            <select
              className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
              value={settings.defaults.mode}
              onChange={(e) => saveDefaults({ mode: e.target.value as JobSettings['mode'] })}
            >
              {COMPRESSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            프리셋
            <select
              className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
              value={settings.defaults.preset}
              onChange={(e) => saveDefaults({ preset: e.target.value as JobSettings['preset'] })}
            >
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p === 'compatibility'
                    ? '호환성 우선'
                    : p === 'space'
                      ? '저장 공간 우선'
                      : '처리 속도 우선'}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            컨테이너
            <select
              className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
              value={settings.defaults.container}
              onChange={(e) =>
                saveDefaults({ container: e.target.value as JobSettings['container'] })
              }
            >
              {OUTPUT_CONTAINERS.map((c) => (
                <option key={c} value={c}>
                  {c.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            코덱
            <select
              className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
              value={settings.defaults.codec}
              onChange={(e) => saveDefaults({ codec: e.target.value as JobSettings['codec'] })}
            >
              {VIDEO_CODECS.map((c) => (
                <option key={c} value={c}>
                  {c === 'h264' ? 'H.264 (호환성 높음)' : 'H.265 (용량 작음)'}
                </option>
              ))}
            </select>
          </label>
          <label className="col-span-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={settings.defaults.externalSubtitles}
              onChange={(e) => saveDefaults({ externalSubtitles: e.target.checked })}
            />
            같은 폴더의 같은 이름 자막 파일(.srt/.ass/.vtt)을 결과에 포함 (작업별로 바꿀 수 있음)
          </label>
        </div>
      </Group>

      <Group title="결과 저장">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.keepLargerResults}
            onChange={(e) => save({ keepLargerResults: e.target.checked })}
          />
          결과가 원본보다 커져도 결과 파일을 보관합니다 (기본: 보관하지 않고 원본만 유지)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.includeSubfoldersDefault}
            onChange={(e) => save({ includeSubfoldersDefault: e.target.checked })}
          />
          폴더 추가 시 하위 폴더를 기본으로 포함
        </label>
        <PathField
          label="결과 접미사"
          value={settings.outputSuffix}
          onSave={(v) => save({ outputSuffix: v || '-slim' })}
        />
        <label className="flex flex-col gap-1 text-sm">
          결과 위치
          <select
            className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
            value={settings.outputFolderMode}
            onChange={(e) =>
              save({ outputFolderMode: e.target.value as AppSettings['outputFolderMode'] })
            }
          >
            <option value="same">원본과 같은 폴더</option>
            <option value="custom">지정한 폴더</option>
          </select>
        </label>
        {settings.outputFolderMode === 'custom' && (
          <PathField
            label="지정 폴더 (절대 경로)"
            value={settings.customOutputDir ?? ''}
            onSave={(v) => save({ customOutputDir: v === '' ? null : v })}
          />
        )}
      </Group>

      <Group title="라이브러리 캐시">
        <CacheSection
          limitMiB={settings.cacheLimitMiB}
          onLimit={(v) => save({ cacheLimitMiB: v })}
        />
      </Group>

      <Group title="지원용 로그">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={maskPaths}
            onChange={(e) => setMaskPaths(e.target.checked)}
          />
          경로를 가리고 내보내기 (파일 위치 등 개인정보 노출 줄이기)
        </label>
        <Button onClick={() => void exportLogs(maskPaths)}>로그 내보내기</Button>
      </Group>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="space-y-3 rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function ToolLine({
  label,
  info,
}: {
  label: string;
  info:
    | { path: string | null; version: string | null; error: string | null; source: string }
    | undefined;
}): ReactNode {
  if (!info) return <p className="text-sm">{label}: 확인 중</p>;
  return (
    <p className="text-sm">
      <span className="font-medium">{label}</span>{' '}
      {info.path ? (
        <span className="text-[var(--c-ok)]">
          찾음 (
          {info.source === 'bundled' ? '번들' : info.source === 'override' ? '사용자 지정' : 'PATH'}
          ) · <span className="text-[var(--c-muted)]">{info.version ?? ''}</span>
        </span>
      ) : (
        <span className="text-[var(--c-danger)]">찾지 못함 — {info.error}</span>
      )}
      {info.error && info.path && <span className="ml-2 text-[var(--c-danger)]">{info.error}</span>}
    </p>
  );
}

function PathField({
  label,
  value,
  onSave,
}: {
  label: string;
  value: string;
  onSave: (v: string) => void;
}): ReactNode {
  const [text, setText] = useState(value);
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <div className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button onClick={() => onSave(text.trim())}>저장</Button>
      </div>
    </label>
  );
}

function CacheSection({
  limitMiB,
  onLimit,
}: {
  limitMiB: number;
  onLimit: (v: number) => void;
}): ReactNode {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [limitText, setLimitText] = useState(String(limitMiB));
  useEffect(() => {
    void libraryApi.cacheStats().then((s) => setStats(s ?? null));
  }, []);
  return (
    <div className="space-y-2 text-sm">
      <p>
        썸네일 {stats ? `${String(stats.thumbCount)}개, ${formatBytes(stats.thumbBytes)}` : '…'} ·
        미리보기 변환본{' '}
        {stats ? `${String(stats.previewCount)}개, ${formatBytes(stats.previewBytes)}` : '…'}
      </p>
      <label className="flex items-center gap-2">
        썸네일 캐시 상한 (MB)
        <input
          type="number"
          min={100}
          step={100}
          className="w-28 rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1.5"
          value={limitText}
          onChange={(e) => setLimitText(e.target.value)}
        />
        <Button
          onClick={() => {
            const n = Number(limitText);
            if (Number.isFinite(n) && n >= 100) onLimit(Math.floor(n));
          }}
        >
          저장
        </Button>
      </label>
      <Button onClick={() => void libraryApi.clearCache().then((s) => setStats(s ?? null))}>
        캐시 비우기 (원본은 건드리지 않음)
      </Button>
    </div>
  );
}
