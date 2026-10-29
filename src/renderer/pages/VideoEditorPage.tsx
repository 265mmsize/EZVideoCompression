/**
 * 영상 편집 화면 (타임라인 기반).
 *
 * - 프로젝트는 앱 DB 에 자동 저장된다 (변경 후 0.6초).
 * - 가운데 미리보기는 재생 헤드 시점의 "원본 프레임"(효과 미적용)이다. 효과를 포함한 실제 결과는
 *   "미리보기 렌더링"(640px 저화질) 또는 "내보내기"로 만든 파일을 재생해서 본다. 화면에 그렇게 표시한다.
 * - 원본 파일은 수정하지 않는다. 내보내기는 새 파일이며 이름이 겹치면 번호를 붙인다.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CANVAS_PRESETS,
  EDIT_FPS,
  EDIT_PRESETS,
  TRANSITIONS,
  TRANSITION_LABELS,
  WATERMARK_POSITIONS,
  type EditClip,
  type EditProject,
  type EditProjectSummary,
  type EditRenderProgress,
  type EditTextOverlay,
  type Rotation,
} from '../../shared/types/domain';
import { subscribe } from '../api';
import { Button } from '../components/ui';
import { formatDuration } from '../format';
import { libraryApi } from '../library/libraryActions';
import { MediaPlayer } from '../library/MediaPlayer';
import { notify } from '../stores/appStore';

const AUTOSAVE_MS = 600;
const PX_PER_SEC_DEFAULT = 40;
const CANVAS_LABELS: Record<(typeof CANVAS_PRESETS)[number], string> = {
  auto: '자동 (첫 클립 크기)',
  '1080p': '1920×1080 (가로)',
  '720p': '1280×720 (가로)',
  '4k': '3840×2160',
  vertical1080: '1080×1920 (세로)',
  square1080: '1080×1080 (정사각형)',
};
const WM_LABELS: Record<(typeof WATERMARK_POSITIONS)[number], string> = {
  topleft: '왼쪽 위',
  topright: '오른쪽 위',
  bottomleft: '왼쪽 아래',
  bottomright: '오른쪽 아래',
  center: '가운데',
};

// ----- 길이 계산 (메인의 EditGraphBuilder 와 같은 규칙) -----
function clipDur(c: EditClip): number {
  return Math.max(0, c.outSec - c.inSec) / c.speed;
}
function transitionSec(prev: EditClip, next: EditClip | undefined): number {
  if (!next || prev.transition.type === 'none') return 0;
  return Math.max(
    0,
    Math.min(prev.transition.durationSec, Math.min(clipDur(prev), clipDur(next)) * 0.5),
  );
}
/** 각 클립의 타임라인 시작 시각과 전체 길이 */
function layout(clips: EditClip[]): { starts: number[]; total: number } {
  const starts: number[] = [];
  let t = 0;
  clips.forEach((c, i) => {
    starts.push(t);
    t += clipDur(c) - transitionSec(c, clips[i + 1]);
  });
  return { starts, total: Math.max(0, t) };
}
function locate(clips: EditClip[], time: number): { index: number; sourceSec: number } | null {
  const { starts } = layout(clips);
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i];
    const s = starts[i];
    if (!c || s === undefined) continue;
    if (time >= s || i === 0) {
      const local = Math.min(Math.max(0, time - s), Math.max(0, clipDur(c) - 0.001));
      return { index: i, sourceSec: c.inSec + local * c.speed };
    }
  }
  return null;
}

export function VideoEditorPage(): ReactNode {
  const [projects, setProjects] = useState<EditProjectSummary[]>([]);
  const [project, setProject] = useState<EditProject | null>(null);
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [pxPerSec, setPxPerSec] = useState(PX_PER_SEC_DEFAULT);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [render, setRender] = useState<EditRenderProgress | null>(null);
  const [panel, setPanel] = useState<'clip' | 'project' | 'export'>('clip');
  const dirty = useRef(false);

  const refreshList = useCallback(async (): Promise<void> => {
    const list = await libraryApi.editProjects();
    if (list) setProjects(list);
  }, []);
  useEffect(() => {
    queueMicrotask(() => void refreshList());
  }, [refreshList]);

  // 렌더 진행 이벤트
  useEffect(
    () =>
      subscribe('edit:render.progress', (p) => {
        setRender((cur) =>
          cur && cur.renderId !== p.renderId && cur.status === 'running' ? cur : p,
        );
        if (p.status === 'done') {
          notify(
            'info',
            p.mode === 'export' ? `내보내기 완료: ${p.outputPath ?? ''}` : '미리보기 렌더링 완료',
          );
        } else if (p.status === 'failed') {
          notify('error', `렌더 실패: ${p.error ?? ''}`);
        }
      }),
    [],
  );

  // 자동 저장
  useEffect(() => {
    if (!project || !dirty.current) return;
    const t = setTimeout(() => {
      dirty.current = false;
      void libraryApi.editSave(project).then((saved) => {
        if (saved) void refreshList();
      });
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [project, refreshList]);

  const update = (fn: (p: EditProject) => EditProject): void => {
    dirty.current = true;
    setProject((p) => (p ? fn(p) : p));
  };
  const updateClip = (id: string, patch: Partial<EditClip> | ((c: EditClip) => EditClip)): void => {
    update((p) => ({
      ...p,
      clips: p.clips.map((c) =>
        c.id === id ? (typeof patch === 'function' ? patch(c) : { ...c, ...patch }) : c,
      ),
    }));
  };

  const clips = useMemo(() => project?.clips ?? [], [project]);
  const { starts, total } = useMemo(() => layout(clips), [clips]);
  const current = clips.find((c) => c.id === selectedClip) ?? null;

  // 재생 헤드 프레임 (원본, 효과 미적용)
  useEffect(() => {
    if (!project || clips.length === 0) return;
    const at = locate(clips, playhead);
    if (!at) return;
    const c = clips[at.index];
    if (!c) return;
    const t = setTimeout(() => {
      void libraryApi.editFrame(c.path, at.sourceSec).then((u) => {
        if (u) setFrameUrl(u);
      });
    }, 150);
    return () => clearTimeout(t);
  }, [project, clips, playhead]);

  // ----- 프로젝트 동작 -----
  const open = async (id: string): Promise<void> => {
    const p = await libraryApi.editGet(id);
    if (!p) return;
    dirty.current = false;
    setProject(p);
    setSelectedClip(p.clips[0]?.id ?? null);
    setPlayhead(0);
    setRender(null);
    setFrameUrl(null);
  };
  const createProject = async (): Promise<void> => {
    const p = await libraryApi.editCreate(`프로젝트 ${String(projects.length + 1)}`);
    if (!p) return;
    await refreshList();
    await open(p.id);
  };
  const removeProject = async (): Promise<void> => {
    if (!project) return;
    await libraryApi.editDelete(project.id);
    setProject(null);
    await refreshList();
  };

  const addClips = async (): Promise<void> => {
    if (!project) return;
    const picked = await libraryApi.editPickMedia('video');
    if (!picked) return;
    for (const path of picked.paths) {
      const info = await libraryApi.editProbe(path);
      if (!info) continue;
      if (!info.hasVideo || info.durationSec === null) {
        notify('error', `${info.fileName}: 영상 트랙이나 길이가 없어 클립으로 쓸 수 없습니다`);
        continue;
      }
      const clip: EditClip = {
        id: crypto.randomUUID(),
        path: info.path,
        fileName: info.fileName,
        sourceDurationSec: info.durationSec,
        sourceWidth: info.width ?? 1280,
        sourceHeight: info.height ?? 720,
        hasAudio: info.hasAudio,
        inSec: 0,
        outSec: info.durationSec,
        speed: 1,
        volume: 1,
        mute: false,
        rotate: 0,
        flipH: false,
        flipV: false,
        filters: { brightness: 0, contrast: 1, saturation: 1, sharpen: 0, denoise: 0 },
        stabilize: false,
        transition: { type: 'none', durationSec: 1 },
        texts: [],
      };
      update((p) => ({ ...p, clips: [...p.clips, clip] }));
      setSelectedClip(clip.id);
    }
  };

  const splitAtPlayhead = (): void => {
    if (!project) return;
    const at = locate(clips, playhead);
    if (!at) return;
    const c = clips[at.index];
    if (!c) return;
    const cut = at.sourceSec;
    if (cut - c.inSec < 0.1 || c.outSec - cut < 0.1) {
      notify('error', '분할 지점이 클립 끝에 너무 가깝습니다');
      return;
    }
    const left: EditClip = { ...c, outSec: cut, transition: { type: 'none', durationSec: 1 } };
    const right: EditClip = { ...c, id: crypto.randomUUID(), inSec: cut, texts: [] };
    update((p) => ({
      ...p,
      clips: p.clips.flatMap((x) => (x.id === c.id ? [left, right] : [x])),
    }));
    setSelectedClip(right.id);
  };
  const moveClip = (id: string, dir: -1 | 1): void => {
    update((p) => {
      const i = p.clips.findIndex((c) => c.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.clips.length) return p;
      const next = [...p.clips];
      const [c] = next.splice(i, 1);
      if (c) next.splice(j, 0, c);
      return { ...p, clips: next };
    });
  };
  const removeClip = (id: string): void => {
    update((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== id) }));
    if (selectedClip === id) setSelectedClip(null);
  };
  const duplicateClip = (id: string): void => {
    update((p) => {
      const i = p.clips.findIndex((c) => c.id === id);
      const c = p.clips[i];
      if (!c) return p;
      const next = [...p.clips];
      next.splice(i + 1, 0, { ...c, id: crypto.randomUUID() });
      return { ...p, clips: next };
    });
  };

  const startRender = async (mode: 'proxy' | 'export', saveAs: boolean): Promise<void> => {
    if (!project) return;
    if (dirty.current) {
      dirty.current = false;
      const saved = await libraryApi.editSave(project);
      if (!saved) return;
    }
    let target: { kind: 'suffix'; suffix: string } | { kind: 'path'; path: string } | null = null;
    if (mode === 'export') {
      if (saveAs) {
        const picked = await libraryApi.editPickExportPath(
          `${project.name}-edit.${project.output.container}`,
          project.output.container,
        );
        if (!picked) return;
        target = { kind: 'path', path: picked.path };
      } else {
        target = { kind: 'suffix', suffix: '-edit' };
      }
    }
    const res = await libraryApi.editRender(project.id, mode, target);
    if (res) {
      setRender({
        renderId: res.renderId,
        projectId: project.id,
        mode,
        status: 'running',
        stage: '준비',
        ratio: null,
        etaSec: null,
        outputPath: null,
        previewId: null,
        error: null,
      });
      setPanel('export');
    }
  };

  // -------------------------------------------------------------------------

  if (!project) {
    return (
      <div className="flex h-full flex-col gap-3 p-4 text-sm">
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => void createProject()}>
            새 프로젝트
          </Button>
          <span className="text-xs text-[var(--c-muted)]">
            클립을 이어 붙이고 자르기·속도·전환·텍스트·배경 음악·워터마크·손떨림 보정을 적용해 새
            영상으로 내보냅니다. 원본은 수정하지 않습니다.
          </span>
        </div>
        {projects.length === 0 ? (
          <p className="text-[var(--c-muted)]">저장된 프로젝트가 없습니다.</p>
        ) : (
          <ul className="grid max-w-3xl grid-cols-1 gap-1" aria-label="프로젝트 목록">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => void open(p.id)}
                  className="flex w-full items-center justify-between rounded border border-[var(--c-border)] px-3 py-2 text-left hover:bg-[var(--c-surface-2)]"
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-[var(--c-muted)]">
                    클립 {p.clipCount}개 · {formatDuration(p.durationSec)} ·{' '}
                    {new Date(p.updatedAt).toLocaleString('ko-KR')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const at = locate(clips, playhead);
  const rendering = render?.status === 'running';

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      {/* 상단 바 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--c-border)] px-3 py-2">
        <Button
          onClick={() => {
            setProject(null);
            void refreshList();
          }}
        >
          ← 프로젝트 목록
        </Button>
        <input
          aria-label="프로젝트 이름"
          className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] px-2 py-1 font-medium"
          value={project.name}
          onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
        />
        <Button variant="primary" onClick={() => void addClips()}>
          클립 추가
        </Button>
        <Button onClick={splitAtPlayhead} disabled={!at}>
          재생 헤드에서 분할
        </Button>
        <span className="text-xs text-[var(--c-muted)]">
          전체 {formatDuration(total)} · 클립 {clips.length}개
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            onClick={() => void startRender('proxy', false)}
            disabled={rendering || clips.length === 0}
          >
            미리보기 렌더링
          </Button>
          <Button
            variant="primary"
            onClick={() => void startRender('export', false)}
            disabled={rendering || clips.length === 0}
          >
            내보내기
          </Button>
          <Button
            onClick={() => void startRender('export', true)}
            disabled={rendering || clips.length === 0}
          >
            다른 이름으로…
          </Button>
          <Button variant="danger" onClick={() => void removeProject()}>
            프로젝트 삭제
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 미리보기 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
            {render?.status === 'done' && render.previewId ? (
              <div className="w-full max-w-4xl p-2">
                <MediaPlayer media={{ kind: 'preview', id: render.previewId }} itemId={null} />
                <p className="mt-1 text-center text-xs text-[var(--c-muted)]">
                  {render.mode === 'proxy'
                    ? '미리보기 렌더 (640px 저화질, 내보내기 결과가 아님)'
                    : `내보내기 결과: ${render.outputPath ?? ''}`}
                  <Button className="ml-2" onClick={() => setRender(null)}>
                    닫기
                  </Button>
                </p>
              </div>
            ) : frameUrl && at ? (
              <>
                <img
                  src={frameUrl}
                  alt="재생 헤드 프레임"
                  data-testid="edit-frame"
                  className="max-h-full max-w-full object-contain"
                />
                <span className="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                  원본 프레임 (효과·전환·텍스트 미적용) · {clips[at.index]?.fileName}{' '}
                  {at.sourceSec.toFixed(2)}초
                </span>
              </>
            ) : (
              <span className="text-xs text-[var(--c-muted)]">
                클립을 추가하면 재생 헤드 시점의 프레임이 보입니다
              </span>
            )}
          </div>

          {/* 타임라인 */}
          <div className="border-t border-[var(--c-border)] p-2">
            <div className="mb-1 flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1">
                재생 헤드
                <input
                  type="range"
                  aria-label="재생 헤드"
                  min={0}
                  max={Math.max(0.1, total)}
                  step={0.05}
                  value={Math.min(playhead, total)}
                  onChange={(e) => setPlayhead(Number(e.target.value))}
                  className="w-64"
                />
                <span className="w-16 tabular-nums">{playhead.toFixed(2)}초</span>
              </label>
              <label className="ml-auto flex items-center gap-1">
                확대
                <input
                  type="range"
                  aria-label="타임라인 확대"
                  min={10}
                  max={200}
                  value={pxPerSec}
                  onChange={(e) => setPxPerSec(Number(e.target.value))}
                />
              </label>
            </div>
            <div
              className="relative h-24 overflow-x-auto rounded border border-[var(--c-border)] bg-[var(--c-surface-2)]"
              role="list"
              aria-label="타임라인"
            >
              <div
                className="relative h-full"
                style={{ width: Math.max(200, total * pxPerSec + 40) }}
              >
                {clips.map((c, i) => {
                  const s = starts[i] ?? 0;
                  const d = clipDur(c);
                  const tr = transitionSec(c, clips[i + 1]);
                  const active = c.id === selectedClip;
                  return (
                    <div
                      key={c.id}
                      role="listitem"
                      aria-label={`클립 ${String(i + 1)}: ${c.fileName}`}
                      aria-selected={active}
                      title={`${c.fileName} ${c.inSec.toFixed(2)}–${c.outSec.toFixed(2)}초 ×${String(c.speed)}`}
                      onClick={() => {
                        setSelectedClip(c.id);
                        setPanel('clip');
                      }}
                      className={`absolute top-2 flex h-14 cursor-pointer flex-col justify-between overflow-hidden rounded border px-1 py-0.5 text-xs ${active ? 'border-[var(--c-accent)] bg-[var(--c-accent)] text-[var(--c-accent-text)]' : 'border-[var(--c-border)] bg-[var(--c-surface)]'}`}
                      style={{ left: s * pxPerSec, width: Math.max(24, d * pxPerSec) }}
                    >
                      <span className="truncate font-medium">{c.fileName}</span>
                      <span className="truncate">
                        {formatDuration(d)}
                        {c.speed !== 1 ? ` ×${String(c.speed)}` : ''}
                        {c.stabilize ? ' · 보정' : ''}
                        {c.texts.length > 0 ? ` · T${String(c.texts.length)}` : ''}
                        {tr > 0
                          ? ` · ${TRANSITION_LABELS[c.transition.type].split(' ')[0] ?? ''}`
                          : ''}
                      </span>
                    </div>
                  );
                })}
                <div
                  className="pointer-events-none absolute top-0 h-full w-0.5 bg-[var(--c-danger)]"
                  style={{ left: Math.min(playhead, total) * pxPerSec }}
                  aria-hidden
                />
              </div>
            </div>
          </div>
        </div>

        {/* 오른쪽 속성 */}
        <aside
          className="w-80 shrink-0 overflow-auto border-l border-[var(--c-border)] p-3"
          aria-label="편집 속성"
        >
          <div className="mb-2 flex gap-1 text-xs" role="tablist">
            {(
              [
                ['clip', '클립'],
                ['project', '프로젝트'],
                ['export', '출력·진행'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={panel === k}
                onClick={() => setPanel(k)}
                className={`rounded px-2 py-1 ${panel === k ? 'bg-[var(--c-accent)] text-[var(--c-accent-text)]' : 'border border-[var(--c-border)]'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {panel === 'clip' &&
            (current ? (
              <ClipPanel
                clip={current}
                index={clips.findIndex((c) => c.id === current.id)}
                count={clips.length}
                playheadSource={at && clips[at.index]?.id === current.id ? at.sourceSec : null}
                onChange={(patch) => updateClip(current.id, patch)}
                onMove={(d) => moveClip(current.id, d)}
                onRemove={() => removeClip(current.id)}
                onDuplicate={() => duplicateClip(current.id)}
              />
            ) : (
              <p className="text-xs text-[var(--c-muted)]">타임라인에서 클립을 선택하세요.</p>
            ))}
          {panel === 'project' && <ProjectPanel project={project} onChange={update} />}
          {panel === 'export' && (
            <ExportPanel
              project={project}
              render={render}
              onChange={update}
              onCancel={() => render && void libraryApi.editRenderCancel(render.renderId)}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className="mt-1 flex flex-col text-xs">
      {label}
      {children}
    </label>
  );
}

function Range(props: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}): ReactNode {
  return (
    <label className="mt-1 flex flex-col text-xs">
      {props.label} {props.value}
      <input
        type="range"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Num(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (v: number) => void;
}): ReactNode {
  return (
    <Field label={props.label}>
      <input
        type="number"
        aria-label={props.label}
        className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step ?? 0.1}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) props.onChange(n);
        }}
      />
    </Field>
  );
}

function ClipPanel({
  clip,
  index,
  count,
  playheadSource,
  onChange,
  onMove,
  onRemove,
  onDuplicate,
}: {
  clip: EditClip;
  index: number;
  count: number;
  playheadSource: number | null;
  onChange: (patch: Partial<EditClip> | ((c: EditClip) => EditClip)) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}): ReactNode {
  const setIn = (v: number): void =>
    onChange({ inSec: Math.max(0, Math.min(v, clip.outSec - 0.1)) });
  const setOut = (v: number): void =>
    onChange({ outSec: Math.min(clip.sourceDurationSec, Math.max(v, clip.inSec + 0.1)) });
  return (
    <div>
      <h3 className="truncate text-sm font-semibold" title={clip.path}>
        {index + 1}. {clip.fileName}
      </h3>
      <p className="text-xs text-[var(--c-muted)]">
        원본 {formatDuration(clip.sourceDurationSec)} · {clip.sourceWidth}×{clip.sourceHeight} ·{' '}
        {clip.hasAudio ? '음성 있음' : '음성 없음'}
      </p>
      <div className="mt-1 flex flex-wrap gap-1">
        <Button onClick={() => onMove(-1)} disabled={index === 0}>
          ← 앞으로
        </Button>
        <Button onClick={() => onMove(1)} disabled={index >= count - 1}>
          뒤로 →
        </Button>
        <Button onClick={onDuplicate}>복제</Button>
        <Button variant="danger" onClick={onRemove}>
          제거
        </Button>
      </div>

      <h4 className="mt-3 text-xs font-semibold text-[var(--c-muted)]">구간 (원본 초)</h4>
      <div className="grid grid-cols-2 gap-1">
        <Num
          label="시작"
          value={round2(clip.inSec)}
          min={0}
          max={clip.sourceDurationSec}
          onChange={setIn}
        />
        <Num
          label="끝"
          value={round2(clip.outSec)}
          min={0}
          max={clip.sourceDurationSec}
          onChange={setOut}
        />
      </div>
      <div className="mt-1 flex gap-1">
        <Button
          disabled={playheadSource === null}
          onClick={() => playheadSource !== null && setIn(playheadSource)}
        >
          재생 헤드를 시작으로
        </Button>
        <Button
          disabled={playheadSource === null}
          onClick={() => playheadSource !== null && setOut(playheadSource)}
        >
          재생 헤드를 끝으로
        </Button>
      </div>

      <h4 className="mt-3 text-xs font-semibold text-[var(--c-muted)]">속도·음성</h4>
      <Range
        label="속도 (배)"
        min={0.25}
        max={4}
        step={0.25}
        value={clip.speed}
        onChange={(v) => onChange({ speed: v })}
      />
      <Range
        label="볼륨"
        min={0}
        max={2}
        step={0.05}
        value={clip.volume}
        onChange={(v) => onChange({ volume: v })}
      />
      <label className="mt-1 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={clip.mute}
          onChange={(e) => onChange({ mute: e.target.checked })}
        />{' '}
        음소거
      </label>

      <h4 className="mt-3 text-xs font-semibold text-[var(--c-muted)]">회전·보정</h4>
      <div className="flex flex-wrap gap-1">
        <Button onClick={() => onChange({ rotate: ((clip.rotate + 90) % 360) as Rotation })}>
          ↻ 90° ({clip.rotate}°)
        </Button>
        <Button
          variant={clip.flipH ? 'primary' : 'ghost'}
          onClick={() => onChange({ flipH: !clip.flipH })}
        >
          좌우
        </Button>
        <Button
          variant={clip.flipV ? 'primary' : 'ghost'}
          onClick={() => onChange({ flipV: !clip.flipV })}
        >
          상하
        </Button>
      </div>
      <Range
        label="밝기"
        min={-0.5}
        max={0.5}
        step={0.01}
        value={clip.filters.brightness}
        onChange={(v) => onChange({ filters: { ...clip.filters, brightness: v } })}
      />
      <Range
        label="대비"
        min={0.5}
        max={2}
        step={0.01}
        value={clip.filters.contrast}
        onChange={(v) => onChange({ filters: { ...clip.filters, contrast: v } })}
      />
      <Range
        label="채도"
        min={0}
        max={3}
        step={0.01}
        value={clip.filters.saturation}
        onChange={(v) => onChange({ filters: { ...clip.filters, saturation: v } })}
      />
      <Range
        label="선명하게"
        min={0}
        max={2}
        step={0.05}
        value={clip.filters.sharpen}
        onChange={(v) => onChange({ filters: { ...clip.filters, sharpen: v } })}
      />
      <Range
        label="노이즈 제거"
        min={0}
        max={10}
        step={0.5}
        value={clip.filters.denoise}
        onChange={(v) => onChange({ filters: { ...clip.filters, denoise: v } })}
      />
      <label className="mt-1 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={clip.stabilize}
          onChange={(e) => onChange({ stabilize: e.target.checked })}
        />{' '}
        손떨림 보정 (vidstab 2-pass, 렌더 시간 증가)
      </label>

      <h4 className="mt-3 text-xs font-semibold text-[var(--c-muted)]">다음 클립으로 전환</h4>
      <Field label="종류">
        <select
          aria-label="전환 종류"
          className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
          value={clip.transition.type}
          disabled={index >= count - 1}
          onChange={(e) =>
            onChange({
              transition: {
                ...clip.transition,
                type: e.target.value as EditClip['transition']['type'],
              },
            })
          }
        >
          {TRANSITIONS.map((t) => (
            <option key={t} value={t}>
              {TRANSITION_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>
      <Range
        label="전환 길이 (초)"
        min={0.1}
        max={5}
        step={0.1}
        value={clip.transition.durationSec}
        onChange={(v) => onChange({ transition: { ...clip.transition, durationSec: v } })}
      />

      <h4 className="mt-3 text-xs font-semibold text-[var(--c-muted)]">
        텍스트 ({clip.texts.length})
      </h4>
      {clip.texts.map((t) => (
        <TextItem
          key={t.id}
          text={t}
          clipDur={clipDur(clip)}
          onChange={(nt) =>
            onChange((c) => ({ ...c, texts: c.texts.map((x) => (x.id === nt.id ? nt : x)) }))
          }
          onRemove={() => onChange((c) => ({ ...c, texts: c.texts.filter((x) => x.id !== t.id) }))}
        />
      ))}
      <Button
        className="mt-1"
        onClick={() =>
          onChange((c) => ({
            ...c,
            texts: [
              ...c.texts,
              {
                id: crypto.randomUUID(),
                text: '제목',
                x: 'center',
                y: 'bottom',
                fontSize: 56,
                color: '#ffffff',
                boxed: true,
                startSec: 0,
                endSec: null,
              },
            ],
          }))
        }
      >
        텍스트 추가
      </Button>
    </div>
  );
}

function TextItem({
  text,
  clipDur: dur,
  onChange,
  onRemove,
}: {
  text: EditTextOverlay;
  clipDur: number;
  onChange: (t: EditTextOverlay) => void;
  onRemove: () => void;
}): ReactNode {
  return (
    <div className="mt-1 rounded border border-[var(--c-border)] p-2">
      <input
        aria-label="텍스트 내용"
        className="w-full rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1 text-xs"
        value={text.text}
        onChange={(e) => onChange({ ...text, text: e.target.value })}
      />
      <div className="mt-1 grid grid-cols-3 gap-1 text-xs">
        <select
          aria-label="가로 위치"
          className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-0.5"
          value={text.x}
          onChange={(e) => onChange({ ...text, x: e.target.value as EditTextOverlay['x'] })}
        >
          <option value="left">왼쪽</option>
          <option value="center">가운데</option>
          <option value="right">오른쪽</option>
        </select>
        <select
          aria-label="세로 위치"
          className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-0.5"
          value={text.y}
          onChange={(e) => onChange({ ...text, y: e.target.value as EditTextOverlay['y'] })}
        >
          <option value="top">위</option>
          <option value="middle">가운데</option>
          <option value="bottom">아래</option>
        </select>
        <input
          type="color"
          aria-label="글자 색"
          value={text.color}
          onChange={(e) => onChange({ ...text, color: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-3 gap-1">
        <Num
          label="크기"
          value={text.fontSize}
          min={8}
          max={400}
          step={1}
          onChange={(v) => onChange({ ...text, fontSize: v })}
        />
        <Num
          label="시작(초)"
          value={round2(text.startSec)}
          min={0}
          max={dur}
          onChange={(v) => onChange({ ...text, startSec: Math.max(0, v) })}
        />
        <Num
          label="끝(초, 0=끝까지)"
          value={text.endSec === null ? 0 : round2(text.endSec)}
          min={0}
          max={dur}
          onChange={(v) => onChange({ ...text, endSec: v <= 0 ? null : v })}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-xs">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={text.boxed}
            onChange={(e) => onChange({ ...text, boxed: e.target.checked })}
          />{' '}
          배경 상자
        </label>
        <Button onClick={onRemove}>삭제</Button>
      </div>
    </div>
  );
}

function ProjectPanel({
  project,
  onChange,
}: {
  project: EditProject;
  onChange: (fn: (p: EditProject) => EditProject) => void;
}): ReactNode {
  const pickMusic = async (): Promise<void> => {
    const picked = await libraryApi.editPickMedia('audio');
    const path = picked?.paths[0];
    if (!path) return;
    const info = await libraryApi.editProbe(path);
    if (!info || !info.hasAudio) {
      notify('error', '음성 트랙이 없는 파일입니다');
      return;
    }
    onChange((p) => ({
      ...p,
      music: {
        path: info.path,
        fileName: info.fileName,
        sourceDurationSec: info.durationSec ?? 0,
        volume: 0.5,
        fadeInSec: 1,
        fadeOutSec: 2,
        loop: true,
        originalMix: 1,
      },
    }));
  };
  const pickWatermark = async (): Promise<void> => {
    const picked = await libraryApi.editPickMedia('image');
    const path = picked?.paths[0];
    if (!path) return;
    const info = await libraryApi.editProbe(path);
    if (!info || !info.hasVideo) {
      notify('error', '이미지를 읽을 수 없습니다');
      return;
    }
    onChange((p) => ({
      ...p,
      watermark: {
        path: info.path,
        fileName: info.fileName,
        position: 'bottomright',
        scale: 0.15,
        opacity: 0.7,
      },
    }));
  };
  const m = project.music;
  const w = project.watermark;
  return (
    <div>
      <h4 className="text-xs font-semibold text-[var(--c-muted)]">캔버스</h4>
      <Field label="크기">
        <select
          aria-label="캔버스 크기"
          className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
          value={project.canvas.preset}
          onChange={(e) =>
            onChange((p) => ({
              ...p,
              canvas: { ...p.canvas, preset: e.target.value as EditProject['canvas']['preset'] },
            }))
          }
        >
          {CANVAS_PRESETS.map((c) => (
            <option key={c} value={c}>
              {CANVAS_LABELS[c]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="프레임레이트">
        <select
          aria-label="프레임레이트"
          className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
          value={String(project.canvas.fps)}
          onChange={(e) =>
            onChange((p) => ({
              ...p,
              canvas: {
                ...p.canvas,
                fps: e.target.value === 'auto' ? 'auto' : (Number(e.target.value) as 24 | 30 | 60),
              },
            }))
          }
        >
          {EDIT_FPS.map((f) => (
            <option key={String(f)} value={String(f)}>
              {f === 'auto' ? '자동 (30)' : `${String(f)} fps`}
            </option>
          ))}
        </select>
      </Field>
      <p className="mt-1 text-xs text-[var(--c-muted)]">
        클립은 비율을 유지한 채 캔버스 안에 맞추고 남는 곳은 검정으로 채웁니다.
      </p>

      <h4 className="mt-3 text-xs font-semibold text-[var(--c-muted)]">배경 음악</h4>
      {m ? (
        <div>
          <p className="truncate text-xs" title={m.path}>
            {m.fileName} ({formatDuration(m.sourceDurationSec)})
          </p>
          <Range
            label="음악 볼륨"
            min={0}
            max={2}
            step={0.05}
            value={m.volume}
            onChange={(v) =>
              onChange((p) => (p.music ? { ...p, music: { ...p.music, volume: v } } : p))
            }
          />
          <Range
            label="원본 음성 유지"
            min={0}
            max={1}
            step={0.05}
            value={m.originalMix}
            onChange={(v) =>
              onChange((p) => (p.music ? { ...p, music: { ...p.music, originalMix: v } } : p))
            }
          />
          <div className="grid grid-cols-2 gap-1">
            <Num
              label="페이드 인(초)"
              value={m.fadeInSec}
              min={0}
              max={30}
              onChange={(v) =>
                onChange((p) =>
                  p.music ? { ...p, music: { ...p.music, fadeInSec: Math.max(0, v) } } : p,
                )
              }
            />
            <Num
              label="페이드 아웃(초)"
              value={m.fadeOutSec}
              min={0}
              max={30}
              onChange={(v) =>
                onChange((p) =>
                  p.music ? { ...p, music: { ...p.music, fadeOutSec: Math.max(0, v) } } : p,
                )
              }
            />
          </div>
          <label className="mt-1 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={m.loop}
              onChange={(e) =>
                onChange((p) =>
                  p.music ? { ...p, music: { ...p.music, loop: e.target.checked } } : p,
                )
              }
            />{' '}
            영상보다 짧으면 반복
          </label>
          <Button className="mt-1" onClick={() => onChange((p) => ({ ...p, music: null }))}>
            음악 제거
          </Button>
        </div>
      ) : (
        <Button onClick={() => void pickMusic()}>배경 음악 추가…</Button>
      )}

      <h4 className="mt-3 text-xs font-semibold text-[var(--c-muted)]">워터마크</h4>
      {w ? (
        <div>
          <p className="truncate text-xs" title={w.path}>
            {w.fileName}
          </p>
          <Field label="위치">
            <select
              aria-label="워터마크 위치"
              className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
              value={w.position}
              onChange={(e) =>
                onChange((p) =>
                  p.watermark
                    ? {
                        ...p,
                        watermark: {
                          ...p.watermark,
                          position: e.target.value as EditProject['watermark'] extends infer T
                            ? T extends { position: infer P }
                              ? P
                              : never
                            : never,
                        },
                      }
                    : p,
                )
              }
            >
              {WATERMARK_POSITIONS.map((pos) => (
                <option key={pos} value={pos}>
                  {WM_LABELS[pos]}
                </option>
              ))}
            </select>
          </Field>
          <Range
            label="크기 (캔버스 너비 대비)"
            min={0.05}
            max={1}
            step={0.01}
            value={w.scale}
            onChange={(v) =>
              onChange((p) => (p.watermark ? { ...p, watermark: { ...p.watermark, scale: v } } : p))
            }
          />
          <Range
            label="불투명도"
            min={0}
            max={1}
            step={0.05}
            value={w.opacity}
            onChange={(v) =>
              onChange((p) =>
                p.watermark ? { ...p, watermark: { ...p.watermark, opacity: v } } : p,
              )
            }
          />
          <Button className="mt-1" onClick={() => onChange((p) => ({ ...p, watermark: null }))}>
            워터마크 제거
          </Button>
        </div>
      ) : (
        <Button onClick={() => void pickWatermark()}>워터마크 이미지 추가…</Button>
      )}
    </div>
  );
}

function ExportPanel({
  project,
  render,
  onChange,
  onCancel,
}: {
  project: EditProject;
  render: EditRenderProgress | null;
  onChange: (fn: (p: EditProject) => EditProject) => void;
  onCancel: () => void;
}): ReactNode {
  const o = project.output;
  return (
    <div>
      <h4 className="text-xs font-semibold text-[var(--c-muted)]">출력 설정</h4>
      <div className="grid grid-cols-2 gap-1">
        <Field label="컨테이너">
          <select
            aria-label="출력 컨테이너"
            className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
            value={o.container}
            onChange={(e) =>
              onChange((p) => ({
                ...p,
                output: { ...p.output, container: e.target.value as 'mp4' | 'mkv' },
              }))
            }
          >
            <option value="mp4">MP4</option>
            <option value="mkv">MKV</option>
          </select>
        </Field>
        <Field label="코덱">
          <select
            aria-label="출력 코덱"
            className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
            value={o.codec}
            onChange={(e) =>
              onChange((p) => ({
                ...p,
                output: { ...p.output, codec: e.target.value as 'h264' | 'hevc' },
              }))
            }
          >
            <option value="h264">H.264</option>
            <option value="hevc">H.265</option>
          </select>
        </Field>
        <Field label="프리셋">
          <select
            aria-label="출력 프리셋"
            className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
            value={o.preset}
            onChange={(e) =>
              onChange((p) => ({
                ...p,
                output: { ...p.output, preset: e.target.value as (typeof EDIT_PRESETS)[number] },
              }))
            }
          >
            {EDIT_PRESETS.map((pr) => (
              <option key={pr} value={pr}>
                {pr === 'veryfast' ? '빠름' : pr === 'medium' ? '보통' : '느림 (작은 용량)'}
              </option>
            ))}
          </select>
        </Field>
        <Num
          label="CRF (낮을수록 고화질)"
          value={o.crf}
          min={10}
          max={40}
          step={1}
          onChange={(v) =>
            onChange((p) => ({
              ...p,
              output: { ...p.output, crf: Math.min(40, Math.max(10, Math.round(v))) },
            }))
          }
        />
      </div>
      <p className="mt-1 text-xs text-[var(--c-muted)]">
        내보내기는 항상 재인코딩입니다. 결과는 첫 클립 폴더에 "프로젝트 이름-edit"로 저장되며 기존
        파일은 덮어쓰지 않습니다. 등록된 라이브러리 폴더면 바로 목록에 나타납니다.
      </p>

      <h4 className="mt-3 text-xs font-semibold text-[var(--c-muted)]">진행</h4>
      {render ? (
        <div className="text-xs" data-testid="render-status">
          <p>
            {render.mode === 'proxy' ? '미리보기 렌더' : '내보내기'} · {render.stage}
            {render.status === 'running' && render.ratio !== null
              ? ` · ${String(Math.round(render.ratio * 100))}%`
              : ''}
            {render.status === 'running' && render.etaSec !== null
              ? ` · 남은 시간 약 ${formatDuration(render.etaSec)}`
              : ''}
          </p>
          {render.status === 'running' && (
            <div className="mt-1 h-2 w-full overflow-hidden rounded bg-[var(--c-surface-2)]">
              <div
                className="h-full bg-[var(--c-accent)]"
                style={{ width: `${String(Math.round((render.ratio ?? 0) * 100))}%` }}
              />
            </div>
          )}
          {render.status === 'running' && (
            <Button className="mt-1" onClick={onCancel}>
              취소
            </Button>
          )}
          {render.status === 'done' && render.outputPath && (
            <p className="mt-1 break-all">
              저장됨: {render.outputPath}
              <Button
                className="ml-1"
                onClick={() => void libraryApi.showInFolder(render.outputPath ?? '')}
              >
                탐색기에서 열기
              </Button>
            </p>
          )}
          {render.status === 'failed' && (
            <p className="mt-1 text-[var(--c-danger)]">{render.error}</p>
          )}
          {render.status === 'cancelled' && (
            <p className="mt-1">취소되었습니다. 임시 파일은 정리되었습니다.</p>
          )}
        </div>
      ) : (
        <p className="text-xs text-[var(--c-muted)]">진행 중인 렌더가 없습니다.</p>
      )}
    </div>
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
