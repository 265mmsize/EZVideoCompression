/**
 * 이미지 편집 화면.
 *
 * - 미리보기는 메인이 FFmpeg 로 만든 축소본이다 (저장 결과와 같은 필터 체인). 화면에서 그린 것이 아니다.
 * - 자르기는 "자르기 모드"에서 원본 위에 사각형을 그려 정한다. 좌표는 원본 픽셀 기준이다.
 * - 원본은 어떤 경우에도 수정하지 않는다. 저장은 새 파일로만 한다.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  CaptureSource,
  ImageEditOps,
  ImageExportFormat,
  ImageExportResult,
  ImageInfo,
  ImagePreview,
  Rotation,
} from '../../shared/types/domain';
import { Button } from '../components/ui';
import { formatBytes } from '../format';
import { libraryApi } from '../library/libraryActions';
import { notify } from '../stores/appStore';
import { useAppStore } from '../hooks/useAppStore';

export const DEFAULT_EDIT_OPS: ImageEditOps = {
  crop: null,
  rotate: 0,
  flipH: false,
  flipV: false,
  angle: 0,
  fillColor: '#ffffff',
  resize: null,
  enhance: {
    sharpen: 0,
    denoise: 0,
    brightness: 0,
    contrast: 1,
    saturation: 1,
    gamma: 1,
    autoLevel: false,
  },
};

const PREVIEW_MAX_WIDTH = 1600;
const PREVIEW_DEBOUNCE_MS = 250;
const RESIZE_PRESETS = [3840, 1920, 1280, 800, 400];
const RATIO_PRESETS: { label: string; ratio: number | null }[] = [
  { label: '자유', ratio: null },
  { label: '1:1', ratio: 1 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '3:2', ratio: 3 / 2 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '9:16', ratio: 9 / 16 },
];

interface Props {
  initialPath: string | null;
}

export function ImageEditorPage({ initialPath }: Props): ReactNode {
  const { tools } = useAppStore();
  const [info, setInfo] = useState<ImageInfo | null>(null);
  const [ops, setOps] = useState<ImageEditOps>(DEFAULT_EDIT_OPS);
  const [history, setHistory] = useState<{ past: ImageEditOps[]; future: ImageEditOps[] }>({
    past: [],
    future: [],
  });
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [cropMode, setCropMode] = useState(false);
  const [ratio, setRatio] = useState<number | null>(null);
  const [format, setFormat] = useState<ImageExportFormat>('keep');
  const [quality, setQuality] = useState(92);
  const [suffix, setSuffix] = useState('-edit');
  const [saving, setSaving] = useState(false);
  const [lastResult, setLastResult] = useState<ImageExportResult | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const webpAvailable = tools?.encoders.includes('libwebp') ?? false;

  // 열기
  const load = useCallback(async (path: string): Promise<void> => {
    const next = await libraryApi.imageOpen(path);
    if (!next) return;
    setInfo(next);
    setOps(DEFAULT_EDIT_OPS);
    setHistory({ past: [], future: [] });
    setPreview(null);
    setLastResult(null);
    setCropMode(false);
  }, []);

  useEffect(() => {
    // 효과 안에서 바로 상태를 바꾸지 않도록 다음 틱으로 미룬다
    if (initialPath) queueMicrotask(() => void load(initialPath));
  }, [initialPath, load]);

  // 미리보기 (디바운스). 같은 요청이 겹치면 메인이 이전 것을 취소한다.
  const seq = useRef(0);
  useEffect(() => {
    if (!info) return;
    const mySeq = ++seq.current;
    const t = setTimeout(() => {
      setPreviewBusy(true);
      void libraryApi.imagePreview(info.path, ops, PREVIEW_MAX_WIDTH).then((p) => {
        if (mySeq !== seq.current) return; // 더 새로운 요청이 있음
        if (p) setPreview(p);
        setPreviewBusy(false);
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [info, ops]);

  const apply = (patch: Partial<ImageEditOps> | ((o: ImageEditOps) => ImageEditOps)): void => {
    setHistory((h) => ({ past: [...h.past.slice(-49), ops], future: [] }));
    setOps((o) => (typeof patch === 'function' ? patch(o) : { ...o, ...patch }));
  };
  const undo = (): void => {
    const prev = history.past[history.past.length - 1];
    if (!prev) return;
    setHistory((h) => ({ past: h.past.slice(0, -1), future: [ops, ...h.future] }));
    setOps(prev);
  };
  const redo = (): void => {
    const next = history.future[0];
    if (!next) return;
    setHistory((h) => ({ past: [...h.past, ops], future: h.future.slice(1) }));
    setOps(next);
  };
  const reset = (): void => {
    apply(() => DEFAULT_EDIT_OPS);
  };

  const outSize = useMemo(
    () => (preview ? { w: preview.width, h: preview.height } : null),
    [preview],
  );

  const doExport = async (target: { kind: 'suffix' } | { kind: 'path' }): Promise<void> => {
    if (!info) return;
    const concrete = format === 'keep' ? keepFormatOf(info.codec) : format;
    let exportTarget: ImageEditOps extends never
      ? never
      : Parameters<typeof libraryApi.imageExport>[0]['target'];
    if (target.kind === 'suffix') {
      exportTarget = { kind: 'suffix', suffix };
    } else {
      const defaultName = `${stripExt(info.fileName)}${suffix}.${concrete === 'jpeg' ? 'jpg' : concrete}`;
      const picked = await libraryApi.imagePickSavePath(defaultName, concrete);
      if (!picked) return;
      exportTarget = { kind: 'path', path: picked.path };
    }
    setSaving(true);
    try {
      const res = await libraryApi.imageExport({
        path: info.path,
        ops,
        format,
        quality,
        target: exportTarget,
      });
      if (res) {
        setLastResult(res);
        notify('info', `저장됨: ${res.outputPath}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const onCaptured = async (path: string): Promise<void> => {
    setCaptureOpen(false);
    await load(path);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--c-border)] px-4 py-2">
        <Button
          variant="primary"
          onClick={() => void libraryApi.imagePickOpen().then((i) => i && void load(i.path))}
        >
          이미지 열기
        </Button>
        <Button onClick={() => setCaptureOpen(true)}>화면 캡처</Button>
        <span className="mx-1 h-5 w-px bg-[var(--c-border)]" />
        <Button onClick={undo} disabled={history.past.length === 0} aria-label="실행 취소">
          실행 취소
        </Button>
        <Button onClick={redo} disabled={history.future.length === 0} aria-label="다시 실행">
          다시 실행
        </Button>
        <Button onClick={reset} disabled={!info}>
          원본으로
        </Button>
        {info && (
          <span className="ml-auto text-xs text-[var(--c-muted)]" data-testid="editor-info">
            {info.fileName} · {info.width}×{info.height} · {formatBytes(info.sizeBytes)} ·{' '}
            {info.codec}
            {info.converted ? ' · 표시용 변환본' : ''}
            {outSize ? ` → 결과 ${String(outSize.w)}×${String(outSize.h)}` : ''}
            {previewBusy ? ' · 미리보기 생성 중…' : ''}
          </span>
        )}
      </div>

      {!info ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-sm text-[var(--c-muted)]">
          <p>
            이미지를 열거나 화면을 캡처하세요. 라이브러리의 이미지 상세에서 "이미지 편집"으로도 열
            수 있습니다.
          </p>
          <p className="text-xs">원본 파일은 수정하지 않습니다. 저장은 항상 새 파일로 합니다.</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-w-0 flex-1 items-center justify-center overflow-auto bg-[var(--c-surface-2)] p-3">
            {cropMode ? (
              <CropCanvas
                info={info}
                crop={ops.crop}
                ratio={ratio}
                onChange={(c) => apply({ crop: c })}
              />
            ) : preview ? (
              <img
                src={preview.url}
                alt="편집 미리보기"
                data-testid="editor-preview"
                width={preview.previewWidth}
                height={preview.previewHeight}
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <span className="text-sm text-[var(--c-muted)]">미리보기 생성 중…</span>
            )}
          </div>

          <aside className="w-80 shrink-0 overflow-auto border-l border-[var(--c-border)] p-3 text-sm">
            <Section title="자르기">
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  variant={cropMode ? 'primary' : 'ghost'}
                  onClick={() => setCropMode((v) => !v)}
                >
                  {cropMode ? '자르기 끝내기' : '자르기 모드'}
                </Button>
                <Button onClick={() => apply({ crop: null })} disabled={!ops.crop}>
                  자르기 해제
                </Button>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {RATIO_PRESETS.map((r) => (
                  <button
                    key={r.label}
                    type="button"
                    className={`rounded border px-1.5 text-xs ${ratio === r.ratio ? 'border-[var(--c-accent)] bg-[var(--c-accent)] text-[var(--c-accent-text)]' : 'border-[var(--c-border)]'}`}
                    onClick={() => {
                      setRatio(r.ratio);
                      if (r.ratio !== null) apply({ crop: centeredCrop(info, r.ratio) });
                    }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <div className="mt-1 grid grid-cols-4 gap-1">
                {(['x', 'y', 'width', 'height'] as const).map((k) => (
                  <label key={k} className="flex flex-col text-xs">
                    {k === 'x' ? 'X' : k === 'y' ? 'Y' : k === 'width' ? '너비' : '높이'}
                    <input
                      type="number"
                      aria-label={`자르기 ${k}`}
                      className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
                      value={
                        ops.crop
                          ? ops.crop[k]
                          : k === 'width'
                            ? info.width
                            : k === 'height'
                              ? info.height
                              : 0
                      }
                      min={0}
                      onChange={(e) => {
                        const n = Math.max(0, Math.round(Number(e.target.value)));
                        const base = ops.crop ?? {
                          x: 0,
                          y: 0,
                          width: info.width,
                          height: info.height,
                        };
                        apply({ crop: clampCrop({ ...base, [k]: n }, info) });
                      }}
                    />
                  </label>
                ))}
              </div>
            </Section>

            <Section title="회전·뒤집기">
              <div className="flex flex-wrap gap-1">
                <Button onClick={() => apply({ rotate: ((ops.rotate + 270) % 360) as Rotation })}>
                  ↺ 90°
                </Button>
                <Button onClick={() => apply({ rotate: ((ops.rotate + 90) % 360) as Rotation })}>
                  ↻ 90°
                </Button>
                <Button
                  variant={ops.flipH ? 'primary' : 'ghost'}
                  onClick={() => apply({ flipH: !ops.flipH })}
                >
                  좌우 뒤집기
                </Button>
                <Button
                  variant={ops.flipV ? 'primary' : 'ghost'}
                  onClick={() => apply({ flipV: !ops.flipV })}
                >
                  상하 뒤집기
                </Button>
              </div>
              <Slider
                label={`미세 회전 ${ops.angle.toFixed(1)}°`}
                min={-45}
                max={45}
                step={0.5}
                value={ops.angle}
                onChange={(v) => apply({ angle: v })}
              />
              <label className="mt-1 flex items-center gap-2 text-xs">
                빈 영역 색
                <input
                  type="color"
                  value={ops.fillColor}
                  onChange={(e) => apply({ fillColor: e.target.value })}
                  aria-label="빈 영역 색"
                />
                <span className="text-[var(--c-muted)]">
                  회전 후 전체가 보이도록 캔버스가 커집니다
                </span>
              </label>
            </Section>

            <Section title="크기 조정">
              <ResizeControls info={info} ops={ops} onChange={(r) => apply({ resize: r })} />
            </Section>

            <Section title="화질 보정">
              <p className="mb-1 text-xs text-[var(--c-muted)]">
                FFmpeg 필터로 보정합니다. AI 복원이 아니므로 없는 세부 정보는 생기지 않습니다.
              </p>
              <Slider
                label={`선명하게 ${ops.enhance.sharpen.toFixed(2)}`}
                min={0}
                max={2}
                step={0.05}
                value={ops.enhance.sharpen}
                onChange={(v) => apply({ enhance: { ...ops.enhance, sharpen: v } })}
              />
              <Slider
                label={`노이즈 제거 ${ops.enhance.denoise.toFixed(1)}`}
                min={0}
                max={10}
                step={0.5}
                value={ops.enhance.denoise}
                onChange={(v) => apply({ enhance: { ...ops.enhance, denoise: v } })}
              />
              <Slider
                label={`밝기 ${ops.enhance.brightness.toFixed(2)}`}
                min={-0.5}
                max={0.5}
                step={0.01}
                value={ops.enhance.brightness}
                onChange={(v) => apply({ enhance: { ...ops.enhance, brightness: v } })}
              />
              <Slider
                label={`대비 ${ops.enhance.contrast.toFixed(2)}`}
                min={0.5}
                max={2}
                step={0.01}
                value={ops.enhance.contrast}
                onChange={(v) => apply({ enhance: { ...ops.enhance, contrast: v } })}
              />
              <Slider
                label={`채도 ${ops.enhance.saturation.toFixed(2)}`}
                min={0}
                max={3}
                step={0.01}
                value={ops.enhance.saturation}
                onChange={(v) => apply({ enhance: { ...ops.enhance, saturation: v } })}
              />
              <Slider
                label={`감마 ${ops.enhance.gamma.toFixed(2)}`}
                min={0.5}
                max={2}
                step={0.01}
                value={ops.enhance.gamma}
                onChange={(v) => apply({ enhance: { ...ops.enhance, gamma: v } })}
              />
              <label className="mt-1 flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={ops.enhance.autoLevel}
                  onChange={(e) =>
                    apply({ enhance: { ...ops.enhance, autoLevel: e.target.checked } })
                  }
                />
                자동 레벨 (가장 어두운 곳과 밝은 곳을 0~255 로 펼침)
              </label>
              <Button className="mt-1" onClick={() => apply({ enhance: DEFAULT_EDIT_OPS.enhance })}>
                보정 초기화
              </Button>
            </Section>

            <Section title="저장">
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs">
                  형식
                  <select
                    className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
                    value={format}
                    onChange={(e) => setFormat(e.target.value as ImageExportFormat)}
                    aria-label="저장 형식"
                  >
                    <option value="keep">
                      원본과 같게 ({keepFormatOf(info.codec).toUpperCase()})
                    </option>
                    <option value="jpeg">JPEG</option>
                    <option value="png">PNG</option>
                    <option value="webp" disabled={!webpAvailable}>
                      WebP{webpAvailable ? '' : ' (이 FFmpeg 에 없음)'}
                    </option>
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  품질 {quality}
                  <input
                    type="range"
                    min={1}
                    max={100}
                    value={quality}
                    disabled={(format === 'keep' ? keepFormatOf(info.codec) : format) === 'png'}
                    onChange={(e) => setQuality(Number(e.target.value))}
                    aria-label="저장 품질"
                  />
                </label>
                <label className="col-span-2 flex flex-col gap-1 text-xs">
                  파일명 접미사 (같은 폴더에 저장)
                  <input
                    className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
                    value={suffix}
                    onChange={(e) => setSuffix(e.target.value)}
                    aria-label="파일명 접미사"
                  />
                </label>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                <Button
                  variant="primary"
                  disabled={saving || !suffix}
                  onClick={() => void doExport({ kind: 'suffix' })}
                >
                  {saving ? '저장 중…' : '같은 폴더에 저장'}
                </Button>
                <Button disabled={saving} onClick={() => void doExport({ kind: 'path' })}>
                  다른 이름으로 저장…
                </Button>
              </div>
              <p className="mt-1 text-xs text-[var(--c-muted)]">
                원본은 수정하지 않습니다. 이름이 겹치면 번호를 붙입니다. EXIF 는 보존되지 않습니다.
              </p>
              {lastResult && (
                <div
                  className="mt-2 rounded border border-[var(--c-border)] p-2 text-xs"
                  data-testid="export-result"
                >
                  <p className="font-medium">저장됨</p>
                  <p className="break-all">{lastResult.outputPath}</p>
                  <p>
                    {lastResult.width}×{lastResult.height} · {formatBytes(lastResult.sizeBytes)} ·{' '}
                    {lastResult.format.toUpperCase()}
                    {lastResult.libraryItemId ? ' · 라이브러리에 반영됨' : ''}
                  </p>
                  {lastResult.notes.map((n) => (
                    <p key={n} className="text-[var(--c-muted)]">
                      {n}
                    </p>
                  ))}
                  <Button
                    className="mt-1"
                    onClick={() => void libraryApi.showInFolder(lastResult.outputPath)}
                  >
                    탐색기에서 열기
                  </Button>
                </div>
              )}
            </Section>
          </aside>
        </div>
      )}

      {captureOpen && (
        <CaptureDialog
          onClose={() => setCaptureOpen(false)}
          onCaptured={(p) => void onCaptured(p)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="mb-3">
      <h3 className="mb-1 text-xs font-semibold text-[var(--c-muted)]">{title}</h3>
      {children}
    </section>
  );
}

function Slider(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}): ReactNode {
  return (
    <label className="mt-1 flex flex-col text-xs">
      {props.label}
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        aria-label={props.label.replace(/ [-\d.]+°?$/, '')}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

function ResizeControls({
  info,
  ops,
  onChange,
}: {
  info: ImageInfo;
  ops: ImageEditOps;
  onChange: (r: ImageEditOps['resize']) => void;
}): ReactNode {
  // 크기 조정은 자르기·회전 뒤의 크기를 기준으로 한다
  const base = sizeAfterGeometry(info, ops);
  const [lock, setLock] = useState(true);
  const cur = ops.resize ?? { width: base.w, height: base.h, filter: 'lanczos' as const };
  const set = (w: number, h: number): void => {
    onChange({
      width: Math.max(1, Math.round(w)),
      height: Math.max(1, Math.round(h)),
      filter: cur.filter,
    });
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {RESIZE_PRESETS.map((w) => (
          <button
            key={w}
            type="button"
            className="rounded border border-[var(--c-border)] px-1.5 text-xs"
            onClick={() => set(w, (w * base.h) / base.w)}
          >
            {w}px
          </button>
        ))}
        <button
          type="button"
          className="rounded border border-[var(--c-border)] px-1.5 text-xs"
          onClick={() => set(base.w / 2, base.h / 2)}
        >
          50%
        </button>
        <button
          type="button"
          className="rounded border border-[var(--c-border)] px-1.5 text-xs"
          onClick={() => onChange(null)}
        >
          원래 크기
        </button>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-1">
        <label className="flex flex-col text-xs">
          너비
          <input
            type="number"
            min={1}
            aria-label="크기 조정 너비"
            className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
            value={cur.width}
            onChange={(e) => {
              const w = Number(e.target.value);
              set(w, lock ? (w * base.h) / base.w : cur.height);
            }}
          />
        </label>
        <label className="flex flex-col text-xs">
          높이
          <input
            type="number"
            min={1}
            aria-label="크기 조정 높이"
            className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
            value={cur.height}
            onChange={(e) => {
              const h = Number(e.target.value);
              set(lock ? (h * base.w) / base.h : cur.width, h);
            }}
          />
        </label>
      </div>
      <div className="mt-1 flex items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> 비율
          유지
        </label>
        <label className="flex items-center gap-1">
          보간
          <select
            className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-0.5"
            value={cur.filter}
            onChange={(e) => onChange({ ...cur, filter: e.target.value as 'lanczos' | 'bicubic' })}
            aria-label="보간 방식"
          >
            <option value="lanczos">Lanczos (선명)</option>
            <option value="bicubic">Bicubic (부드러움)</option>
          </select>
        </label>
      </div>
      {ops.resize && (ops.resize.width > base.w || ops.resize.height > base.h) && (
        <p className="mt-1 text-xs text-[var(--c-muted)]">
          확대는 보간일 뿐이며 원본에 없는 세부 정보는 생기지 않습니다.
        </p>
      )}
    </div>
  );
}

/** 자르기 모드 캔버스: 원본 위에 사각형을 드래그해 영역을 정한다 (좌표는 원본 픽셀) */
function CropCanvas({
  info,
  crop,
  ratio,
  onChange,
}: {
  info: ImageInfo;
  crop: ImageEditOps['crop'];
  ratio: number | null;
  onChange: (c: NonNullable<ImageEditOps['crop']>) => void;
}): ReactNode {
  const imgRef = useRef<HTMLImageElement>(null);
  const [drag, setDrag] = useState<{
    x0: number;
    y0: number;
    mode: 'new' | 'move';
    start: NonNullable<ImageEditOps['crop']>;
  } | null>(null);

  const toImage = (e: React.MouseEvent): { x: number; y: number } => {
    const el = imgRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const sx = info.width / r.width;
    const sy = info.height / r.height;
    return {
      x: Math.min(info.width, Math.max(0, (e.clientX - r.left) * sx)),
      y: Math.min(info.height, Math.max(0, (e.clientY - r.top) * sy)),
    };
  };

  const onDown = (e: React.MouseEvent): void => {
    e.preventDefault();
    const p = toImage(e);
    const inside =
      crop &&
      p.x >= crop.x &&
      p.x <= crop.x + crop.width &&
      p.y >= crop.y &&
      p.y <= crop.y + crop.height;
    setDrag({
      x0: p.x,
      y0: p.y,
      mode: inside ? 'move' : 'new',
      start: crop ?? { x: 0, y: 0, width: 0, height: 0 },
    });
  };
  const onMove = (e: React.MouseEvent): void => {
    if (!drag) return;
    const p = toImage(e);
    if (drag.mode === 'move') {
      const nx = drag.start.x + (p.x - drag.x0);
      const ny = drag.start.y + (p.y - drag.y0);
      onChange(
        clampCrop(
          {
            x: Math.min(Math.max(0, nx), info.width - drag.start.width),
            y: Math.min(Math.max(0, ny), info.height - drag.start.height),
            width: drag.start.width,
            height: drag.start.height,
          },
          info,
        ),
      );
      return;
    }
    const w = Math.abs(p.x - drag.x0);
    let h = Math.abs(p.y - drag.y0);
    if (ratio !== null) {
      // 비율 고정: 너비 기준으로 높이를 맞춘다
      h = w / ratio;
    }
    const x = p.x < drag.x0 ? drag.x0 - w : drag.x0;
    const y = p.y < drag.y0 ? drag.y0 - h : drag.y0;
    if (w >= 2 && h >= 2) onChange(clampCrop({ x, y, width: w, height: h }, info));
  };
  const onUp = (): void => setDrag(null);

  // 표시 배율은 이미지 로드·창 크기 변경 때 측정해 상태로 둔다 (렌더 중 ref 접근 금지)
  const [scale, setScale] = useState(1);
  const measure = useCallback((): void => {
    const el = imgRef.current;
    if (el && el.getBoundingClientRect().width > 0) {
      setScale(el.getBoundingClientRect().width / info.width);
    }
  }, [info.width]);
  useEffect(() => {
    const el = imgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div
      className="relative select-none"
      onMouseDown={onDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={onUp}
    >
      <img
        ref={imgRef}
        src={info.url}
        alt="원본"
        onLoad={measure}
        draggable={false}
        className="max-h-[80vh] max-w-full object-contain"
      />
      {crop && (
        <div
          aria-label="자르기 영역"
          className="pointer-events-none absolute border-2 border-[var(--c-accent)]"
          style={{
            left: crop.x * scale,
            top: crop.y * scale,
            width: crop.width * scale,
            height: crop.height * scale,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
          }}
        />
      )}
      <p className="absolute bottom-1 left-1 rounded bg-black/60 px-1 text-xs text-white">
        드래그로 영역을 그리고, 영역 안을 끌어 옮깁니다.{' '}
        {crop ? `${String(crop.width)}×${String(crop.height)}` : '영역 없음'}
      </p>
    </div>
  );
}

function CaptureDialog({
  onClose,
  onCaptured,
}: {
  onClose: () => void;
  onCaptured: (path: string) => void;
}): ReactNode {
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [delay, setDelay] = useState(0);
  const [hideApp, setHideApp] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const list = await libraryApi.captureSources();
    setSources(list ?? []);
  }, []);
  useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);

  const take = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await libraryApi.captureTake(selected, delay, hideApp);
      if (res) {
        notify('info', `캡처 저장됨: ${res.path}`);
        onCaptured(res.path);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="화면 캡처"
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-6"
    >
      <div className="max-h-full w-[720px] overflow-auto rounded-lg border border-[var(--c-border)] bg-[var(--c-surface)] p-4 text-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">화면 캡처</h2>
          <Button onClick={onClose}>닫기</Button>
        </div>
        <p className="mb-2 text-xs text-[var(--c-muted)]">
          캡처 대상을 고르세요. PNG 로 사진 폴더의 "VideoSlim 캡처"에 저장되고 편집기에 열립니다.
          네트워크로 보내지 않습니다.
        </p>
        {sources === null ? (
          <p>대상 목록을 가져오는 중…</p>
        ) : sources.length === 0 ? (
          <p>캡처할 수 있는 화면이나 창이 없습니다.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2" role="listbox" aria-label="캡처 대상">
            {sources.map((s) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={selected === s.id}
                aria-label={s.name}
                onClick={() => setSelected(s.id)}
                className={`rounded border p-1 text-left ${selected === s.id ? 'border-[var(--c-accent)]' : 'border-[var(--c-border)]'}`}
              >
                <img
                  src={s.thumbnailDataUrl}
                  alt=""
                  className="h-24 w-full object-contain bg-black"
                />
                <span className="mt-1 block truncate text-xs">
                  {s.kind === 'screen' ? '화면' : '창'} · {s.name}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1">
            지연
            <select
              className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-0.5"
              value={delay}
              onChange={(e) => setDelay(Number(e.target.value))}
              aria-label="캡처 지연"
            >
              <option value={0}>없음</option>
              <option value={3}>3초</option>
              <option value={5}>5초</option>
              <option value={10}>10초</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={hideApp}
              onChange={(e) => setHideApp(e.target.checked)}
            />{' '}
            캡처 전 이 앱 창 최소화
          </label>
          <Button onClick={() => void refresh()}>목록 새로 고침</Button>
          <Button variant="primary" disabled={!selected || busy} onClick={() => void take()}>
            {busy ? '캡처 중…' : '캡처'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function keepFormatOf(codec: string): 'jpeg' | 'png' | 'webp' {
  if (codec === 'mjpeg') return 'jpeg';
  if (codec === 'webp') return 'webp';
  return 'png';
}

function clampCrop(
  c: NonNullable<ImageEditOps['crop']>,
  info: { width: number; height: number },
): NonNullable<ImageEditOps['crop']> {
  const x = Math.min(Math.max(0, Math.round(c.x)), info.width - 1);
  const y = Math.min(Math.max(0, Math.round(c.y)), info.height - 1);
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(c.width), info.width - x)),
    height: Math.max(1, Math.min(Math.round(c.height), info.height - y)),
  };
}

function centeredCrop(info: ImageInfo, ratio: number): NonNullable<ImageEditOps['crop']> {
  let w = info.width;
  let h = Math.round(w / ratio);
  if (h > info.height) {
    h = info.height;
    w = Math.round(h * ratio);
  }
  return {
    x: Math.round((info.width - w) / 2),
    y: Math.round((info.height - h) / 2),
    width: w,
    height: h,
  };
}

/** 자르기·회전 뒤 크기 (크기 조정 전). 메인의 predictOutputSize 와 같은 계산 */
function sizeAfterGeometry(info: ImageInfo, ops: ImageEditOps): { w: number; h: number } {
  let w = ops.crop ? ops.crop.width : info.width;
  let h = ops.crop ? ops.crop.height : info.height;
  if (ops.rotate === 90 || ops.rotate === 270) [w, h] = [h, w];
  if (ops.angle !== 0) {
    const a = (Math.abs(ops.angle) * Math.PI) / 180;
    const rw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
    const rh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
    w = Math.floor(rw + 0.5);
    h = Math.floor(rh + 0.5);
  }
  return { w, h };
}
