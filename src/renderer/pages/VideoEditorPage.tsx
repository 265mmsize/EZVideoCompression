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
  type EditTrack,
  type EditTrackClip,
  type Rotation,
} from '../../shared/types/domain';
import { subscribe } from '../api';
import { emptyHistory, recordChange, redo, undo, type History } from './historyStack';
import {
  chapterLines,
  clipDur,
  layout,
  splitByInterval,
  splitEqually,
  transitionSec,
} from './editOps';
import {
  boundaryTimes,
  cutOut,
  cutOutTracks,
  moveClipToTrack,
  keepOnly,
  keepOnlyTracks,
  moveTrackClip,
  trackBoundaryTimes,
  trimTrackClip,
  moveTime,
  normalizeRange,
  snapTime,
  trimEdge,
  type TimeRange,
  type TrimEdge,
} from './timelineOps';
import { Button } from '../components/ui';
import { formatDuration } from '../format';
import { libraryApi } from '../library/libraryActions';
import { MediaPlayer } from '../library/MediaPlayer';
import { TimelinePreview } from './TimelinePreview';
import { Waveform } from './Waveform';
import { MusicRow, TrackRows, type TrackSel } from './TrackRows';
import { sliceMotion } from '../../shared/keyframes';
import { TrackClipPanel } from './TrackClipPanel';
import { MotionPanel, motionTimes } from './MotionPanel';
import { ClipThumbs } from './ClipThumbs';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { copyOf, freezeAt } from './clipEdits';
import { clipLabel, maxFadeSec } from '../../shared/clipTime';
import { vocalAvailability } from '../../shared/audioClean';
import { notify } from '../stores/appStore';
import { useAppStore } from '../hooks/useAppStore';

const AUTOSAVE_MS = 600;
const FILMSTRIP_COUNT = 8;
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

/** 선택한 클립의 원본 프레임 8장 (구간 안에서 고르게). 한 장씩 차례로 읽는다. 원본 기준이라 효과·전환은 보이지 않는다. */
function FilmStrip({ clip }: { clip: EditClip }): ReactNode {
  const [frames, setFrames] = useState<(string | null)[]>([]);
  useEffect(() => {
    const live = { on: true };
    const span = Math.max(0, clip.outSec - clip.inSec);
    void (async () => {
      for (let i = 0; i < FILMSTRIP_COUNT; i++) {
        const t = clip.inSec + (span * (i + 0.5)) / FILMSTRIP_COUNT;
        const url = await libraryApi.editFrame(clip.path, t);
        if (!live.on) return;
        setFrames((prev) => {
          const next = [...prev];
          next[i] = url;
          return next;
        });
      }
    })();
    return () => {
      live.on = false;
    };
  }, [clip.path, clip.inSec, clip.outSec]);
  return (
    <div
      role="img"
      aria-label="필름스트립 (선택 클립의 원본 프레임)"
      className="mb-1 flex h-16 gap-px overflow-hidden rounded border border-[var(--c-border)] bg-black"
    >
      {Array.from({ length: FILMSTRIP_COUNT }, (_, i) => {
        const u = frames[i];
        return u ? (
          <img key={i} src={u} alt="" className="h-full min-w-0 flex-1 object-cover" />
        ) : (
          <div key={i} className="h-full flex-1 bg-[var(--c-surface-2)]" />
        );
      })}
    </div>
  );
}

/** 타임라인 포인터 동작 상태: 눈금 끌기(구간), 트랙 클릭(재생 헤드), 클립 가장자리(트림) */
type DragState =
  | { kind: 'range'; anchorSec: number; startX: number; moved: boolean }
  | { kind: 'scrub'; startX: number; moved: boolean }
  | { kind: 'trim'; id: string; edge: TrimEdge; base: EditClip; startX: number }
  | {
      kind: 'tmove';
      trackId: string;
      id: string;
      base: EditTrackClip;
      startX: number;
      moved: boolean;
    }
  | {
      kind: 'ttrim';
      trackId: string;
      id: string;
      edge: TrimEdge;
      base: EditTrackClip;
      startX: number;
      moved: boolean;
    };

/** 되돌리기 병합 판정용 현재 시각 (이벤트 처리에서만 쓴다) */
function wallClockMs(): number {
  return Date.now();
}

/** 눈금 간격: 확대 정도에 따라 1·5·10초 */
function rulerTicks(total: number, pxPerSec: number): number[] {
  const step = pxPerSec >= 30 ? 1 : pxPerSec >= 12 ? 5 : 10;
  return Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
}

/** 끌어 놓은 x 좌표(픽셀)가 놓인 클립의 가운데 앞쪽 위치. 그 클립 자리로 옮긴다. */
function dropIndexAt(clips: EditClip[], starts: number[], xPx: number, pxPerSec: number): number {
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (!c) continue;
    const mid = ((starts[i] ?? 0) + clipDur(c) / 2) * pxPerSec;
    if (xPx < mid) return i;
  }
  return Math.max(0, clips.length - 1);
}

/** 클립 하나를 다른 위치로 옮긴 새 프로젝트를 돌려준다 (원본 객체는 바꾸지 않는다) */
function reorderClip(p: EditProject, id: string, to: number): EditProject {
  const from = p.clips.findIndex((c) => c.id === id);
  if (from < 0 || to < 0 || to >= p.clips.length || from === to) return p;
  const next = [...p.clips];
  const [c] = next.splice(from, 1);
  if (c) next.splice(to, 0, c);
  return { ...p, clips: next };
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
  const projRef = useRef<EditProject | null>(null);
  const hist = useRef<History<EditProject>>(emptyHistory());
  const [histCount, setHistCount] = useState({ u: 0, r: 0 });
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [pxPerSec, setPxPerSec] = useState(PX_PER_SEC_DEFAULT);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [render, setRender] = useState<EditRenderProgress | null>(null);
  const [panel, setPanel] = useState<'clip' | 'project' | 'export'>('clip');
  // 구간 선택(눈금 끌기 또는 I·O 키), 다중 선택 클립, 포인터 동작 상태
  const [rangeSel, setRangeSel] = useState<{ a: number; b: number } | null>(null);
  // 실시간 미리보기 재생 (근사치). 재생을 시작한 위치를 기억해 그 위치부터 다시 그린다.
  const [playing, setPlaying] = useState(false);
  const [playFrom, setPlayFrom] = useState(0);
  // 구간만 재생할 때의 끝 시각 (null 이면 끝까지)
  const [playEnd, setPlayEnd] = useState<number | null>(null);
  // 우클릭 메뉴와 복사한 클립, 썸네일·맞춤·전체 화면에 쓰는 요소
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const clipboardRef = useRef<EditClip | null>(null);
  const [hasClipboard, setHasClipboard] = useState(false);
  const trackBoxRef = useRef<HTMLDivElement>(null);
  const previewBoxRef = useRef<HTMLDivElement>(null);
  // 고른 추가 트랙 클립 (메인 클립 선택과 함께 쓰지 않는다)
  const [selTrack, setSelTrack] = useState<TrackSel | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const dragRef = useRef<DragState | null>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const dragClip = useRef<string | null>(null);

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

  /** 프로젝트 상태를 바꾸는 유일한 통로. 실행 취소 스택에 변경 전 상태를 남긴다. */
  const commit = (next: EditProject | null, record: boolean, key: string | null = null): void => {
    const cur = projRef.current;
    if (record && cur && next) {
      hist.current = recordChange(hist.current, cur, wallClockMs(), key);
      setHistCount({ u: hist.current.past.length, r: hist.current.future.length });
    }
    if (next) dirty.current = true;
    projRef.current = next;
    setProject(next);
  };
  /** key 가 같은 연속 변경(슬라이더 등)은 한 단계로 묶는다. 생략하면 변경마다 한 단계다. */
  const update = (fn: (p: EditProject) => EditProject, key: string | null = null): void => {
    const cur = projRef.current;
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    commit(next, true, key);
  };
  const doUndo = (): void => {
    const cur = projRef.current;
    if (!cur) return;
    const r = undo(hist.current, cur);
    if (!r) return;
    hist.current = r.history;
    commit(r.state, false);
    setHistCount({ u: hist.current.past.length, r: hist.current.future.length });
  };
  const doRedo = (): void => {
    const cur = projRef.current;
    if (!cur) return;
    const r = redo(hist.current, cur);
    if (!r) return;
    hist.current = r.history;
    commit(r.state, false);
    setHistCount({ u: hist.current.past.length, r: hist.current.future.length });
  };

  // 실행 취소 단축키 (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z). 입력칸에서는 브라우저 기본 동작을 쓴다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        doUndo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        doRedo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // doUndo/doRedo 는 ref 와 안정적인 setState 만 쓰므로 한 번만 등록한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const updateClip = (id: string, patch: Partial<EditClip> | ((c: EditClip) => EditClip)): void => {
    update(
      (p) => ({
        ...p,
        clips: p.clips.map((c) =>
          c.id === id ? (typeof patch === 'function' ? patch(c) : { ...c, ...patch }) : c,
        ),
      }),
      `clip:${id}`,
    );
  };

  const clips = useMemo(() => project?.clips ?? [], [project]);
  const tracks = useMemo(() => project?.tracks ?? [], [project]);
  const { starts, total } = useMemo(() => layout(clips), [clips]);
  const current = clips.find((c) => c.id === selectedClip) ?? null;

  // 재생 헤드 프레임 (원본, 효과 미적용)
  useEffect(() => {
    if (!project || clips.length === 0 || playing) return;
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
  }, [project, clips, playhead, playing]);

  // ----- 프로젝트 동작 -----
  const open = async (id: string): Promise<void> => {
    const p = await libraryApi.editGet(id);
    if (!p) return;
    dirty.current = false;
    hist.current = emptyHistory();
    setHistCount({ u: 0, r: 0 });
    projRef.current = p;
    setProject(p);
    setSelectedClip(p.clips[0]?.id ?? null);
    setPlayhead(0);
    setRender(null);
    setFrameUrl(null);
    setPlaying(false);
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
    projRef.current = null;
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
        hdr: info.hdr,
        audioChannels: info.audioChannels,
        noiseReduce: 'off',
        vocal: 'off',
        bitDepth: info.bitDepth,
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
    const splitT = (cut - c.inSec) / c.speed;
    const left: EditClip = {
      ...c,
      outSec: cut,
      transition: { type: 'none', durationSec: 1 },
      motion: sliceMotion(c.motion, 0, splitT),
    };
    const right: EditClip = {
      ...c,
      id: crypto.randomUUID(),
      inSec: cut,
      texts: [],
      motion: sliceMotion(c.motion, splitT, clipDur(c)),
    };
    update((p) => ({
      ...p,
      clips: p.clips.flatMap((x) => (x.id === c.id ? [left, right] : [x])),
    }));
    setSelectedClip(right.id);
  };
  /** 미저장 변경을 먼저 기록한다. 변경이 없거나 기록에 성공하면 true. */
  const flushSave = async (): Promise<boolean> => {
    const cur = projRef.current;
    if (!cur || !dirty.current) return true;
    const saved = await libraryApi.editSave(cur);
    if (saved) dirty.current = false;
    return Boolean(saved);
  };
  /** 현재 프로젝트를 .kcp 파일로 내보낸다 (원본 미디어는 건드리지 않는다) */
  const saveKcp = async (): Promise<void> => {
    const cur = projRef.current;
    if (!cur || !(await flushSave())) return;
    const r = await libraryApi.exportKcp(cur.id);
    if (r) notify('info', `프로젝트 파일 저장됨: ${r.path}`);
  };
  /** .kcp 파일을 새 프로젝트로 가져와 연다 */
  const openKcp = async (): Promise<void> => {
    if (!(await flushSave())) return;
    const r = await libraryApi.importKcp();
    if (!r) return;
    await refreshList();
    await open(r.id);
    notify('info', `프로젝트를 열었습니다: ${r.name}`);
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
  const splitInterval = (id: string, seconds: number): void => {
    const target = projRef.current?.clips.find((c) => c.id === id);
    if (!target) return;
    const parts = splitByInterval(target, seconds, () => crypto.randomUUID());
    if (parts.length < 2) {
      notify('error', '간격이 너무 크거나 작거나, 조각이 50개를 넘어 나눌 수 없습니다');
      return;
    }
    update((p) => ({ ...p, clips: p.clips.flatMap((c) => (c.id === id ? parts : [c])) }));
    setSelectedClip(parts[0]?.id ?? null);
  };
  const splitEqual = (id: string, n: number): void => {
    const target = projRef.current?.clips.find((c) => c.id === id);
    if (!target) return;
    const parts = splitEqually(target, n, () => crypto.randomUUID());
    if (parts.length < 2) {
      notify('error', '클립이 너무 짧거나 조각 수(2~10)가 맞지 않아 나눌 수 없습니다');
      return;
    }
    update((p) => ({ ...p, clips: p.clips.flatMap((c) => (c.id === id ? parts : [c])) }));
    setSelectedClip(parts[0]?.id ?? null);
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

  /** 무손실 합치기 확인 (저장되지 않은 변경을 먼저 저장한다) */
  const losslessCheck = async (): Promise<{ ok: boolean; reasons: string[] } | null> => {
    const cur = projRef.current;
    if (!cur || !(await flushSave())) return null;
    return (await libraryApi.editLosslessCheck(cur.id)) ?? null;
  };
  /** 재인코딩 없이 합치기 (진행은 렌더와 같은 표시를 쓴다) */
  const losslessMerge = async (): Promise<void> => {
    const cur = projRef.current;
    if (!cur || !(await flushSave())) return;
    const res = await libraryApi.editLosslessMerge(cur.id, { kind: 'suffix', suffix: '-merge' });
    if (!res) return;
    setRender({
      renderId: res.renderId,
      projectId: cur.id,
      mode: 'export',
      status: 'running',
      stage: '무손실 합치기 확인',
      ratio: null,
      etaSec: null,
      outputPath: null,
      previewId: null,
      error: null,
    });
    setPanel('export');
  };

  // -------------------------------------------------------------------------

  // ----- 클립 편집: 복사·붙여넣기·복제, 프레임 고정, 구간 재생, 이동·맞춤, 전체 화면 -----
  const selectedMain = (): EditClip | null => clips.find((c) => c.id === selectedClip) ?? null;
  const copyClip = (id: string): void => {
    const c = clips.find((x) => x.id === id);
    if (!c) return;
    clipboardRef.current = c;
    setHasClipboard(true);
    notify('info', `복사: ${clipLabel(c)}`);
  };
  /** 붙여넣기: 선택한 클립 뒤에 넣는다 (선택이 없으면 맨 뒤) */
  const pasteClip = (): void => {
    const src = clipboardRef.current;
    if (!src) return;
    const copy = copyOf(src, () => crypto.randomUUID());
    update((p) => {
      const i = p.clips.findIndex((c) => c.id === selectedClip);
      const at = i < 0 ? p.clips.length : i + 1;
      const next = [...p.clips];
      next.splice(at, 0, copy);
      return { ...p, clips: next };
    });
    setSelectedClip(copy.id);
  };
  /** 재생 헤드 위치에서 클립을 프레임 고정 (앞·고정·뒤 세 조각) */
  const freezeSelected = (): void => {
    const c = selectedMain();
    if (!c) {
      notify('error', '프레임 고정할 클립을 고르세요');
      return;
    }
    const idx = clips.findIndex((x) => x.id === c.id);
    const local = playhead - (starts[idx] ?? 0);
    if (local <= 0 || local >= clipDur(c)) {
      notify('error', '재생 헤드를 고를 클립 안에 두세요');
      return;
    }
    const pieces = freezeAt(c, c.inSec + local * c.speed, () => crypto.randomUUID());
    if (!pieces) {
      notify('error', '재생 헤드가 클립 가장자리에 너무 가깝습니다');
      return;
    }
    update((p) => ({ ...p, clips: p.clips.flatMap((x) => (x.id === c.id ? pieces : [x])) }));
    setSelectedClip(pieces[1]?.id ?? null);
  };
  const jumpBy = (sec: number): void => {
    setPlaying(false);
    setPlayhead((t) => moveTime(t, total, sec));
  };
  /** 선택 구간만 미리 재생한다 (프로젝트는 바뀌지 않는다) */
  const playRange = (): void => {
    if (!range) return;
    setPlayFrom(range.startSec);
    setPlayEnd(range.endSec);
    setPlaying(true);
  };
  /** 타임라인을 가로 폭에 맞춘다 */
  const zoomFit = (): void => {
    const w = trackBoxRef.current?.clientWidth ?? 0;
    if (total <= 0 || w <= 0) return;
    setPxPerSec(Math.min(200, Math.max(10, Math.floor((w - 24) / total))));
  };
  const fullscreenPreview = (): void => {
    const el = previewBoxRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    el.requestFullscreen().catch(() => notify('error', '전체 화면으로 바꿀 수 없습니다'));
  };
  /** 우클릭 메뉴 항목 */
  const clipMenuEntries = (id: string): MenuEntry[] => {
    const c = clips.find((x) => x.id === id);
    if (!c) return [];
    return [
      { label: '복제', hint: 'Ctrl+D', onSelect: () => duplicateClip(id) },
      { label: '복사', hint: 'Ctrl+C', onSelect: () => copyClip(id) },
      {
        label: '붙여넣기',
        hint: 'Ctrl+V',
        disabled: !hasClipboard,
        onSelect: () => pasteClip(),
      },
      { sep: true },
      { label: '분할', hint: 'S · 재생 헤드', onSelect: () => splitAtPlayhead() },
      { label: '프레임 고정', hint: 'F · 재생 헤드', onSelect: () => freezeSelected() },
      { label: '이름·길이·페이드 편집', onSelect: () => setPanel('clip') },
      { sep: true },
      { label: '삭제', hint: 'Delete', danger: true, onSelect: () => removeClip(id) },
    ];
  };

  // ----- 추가 트랙 (모두 실행 취소 가능) -----
  const updateTrackClip = (
    trackId: string,
    clipId: string,
    fn: (c: EditTrackClip) => EditTrackClip,
    key: string | null,
  ): void => {
    update(
      (p) => ({
        ...p,
        tracks: p.tracks.map((t) =>
          t.id !== trackId ? t : { ...t, clips: t.clips.map((c) => (c.id === clipId ? fn(c) : c)) },
        ),
      }),
      key,
    );
  };
  const addTrack = (kind: EditTrack['kind']): void => {
    update((p) => {
      if (p.tracks.length >= 20) return p;
      const n = p.tracks.filter((t) => t.kind === kind).length + 1;
      const name = `${kind === 'video' ? '영상' : '오디오'} ${String(n)}`;
      return {
        ...p,
        tracks: [...p.tracks, { id: crypto.randomUUID(), kind, name, enabled: true, clips: [] }],
      };
    });
  };
  const removeTrack = (trackId: string): void => {
    update((p) => ({ ...p, tracks: p.tracks.filter((t) => t.id !== trackId) }));
    if (selTrack?.trackId === trackId) setSelTrack(null);
  };
  const toggleTrack = (trackId: string): void => {
    update((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, enabled: !t.enabled } : t)),
    }));
  };
  const removeTrackClip = (sel: TrackSel): void => {
    update((p) => ({
      ...p,
      tracks: p.tracks.map((t) =>
        t.id !== sel.trackId ? t : { ...t, clips: t.clips.filter((c) => c.id !== sel.clipId) },
      ),
    }));
    setSelTrack(null);
  };
  const selectTrackClip = (sel: TrackSel): void => {
    setSelTrack(sel);
    setSelectedClip(null);
    setPicked(new Set());
    setPanel('clip');
  };
  /** 파일을 골라 재생 헤드 위치부터 트랙에 차례로 놓는다. 이미지는 5초로 놓는다. */
  const addTrackMedia = async (
    trackId: string,
    kind: 'video' | 'image' | 'audio',
  ): Promise<void> => {
    const picked = await libraryApi.editPickMedia(kind);
    if (!picked) return;
    let at = playhead;
    const added: EditTrackClip[] = [];
    for (const path of picked.paths) {
      const info = await libraryApi.editProbe(path);
      if (!info) continue;
      const isImage = info.kind === 'image';
      if (kind === 'image' && !isImage) {
        notify('error', `${info.fileName}: 이미지 파일이 아닙니다`);
        continue;
      }
      if (kind === 'audio' && !info.hasAudio) {
        notify('error', `${info.fileName}: 음성이 없어 오디오 트랙에 넣을 수 없습니다`);
        continue;
      }
      if (kind === 'video' && (!info.hasVideo || isImage)) {
        notify('error', `${info.fileName}: 영상 파일이 아닙니다 (이미지는 "+ 이미지"로 넣습니다)`);
        continue;
      }
      if (!isImage && !(info.durationSec !== null && info.durationSec > 0)) {
        notify('error', `${info.fileName}: 길이를 알 수 없습니다`);
        continue;
      }
      const srcDur = isImage ? 86_400 : (info.durationSec ?? 0);
      const len = isImage ? 5 : srcDur;
      added.push({
        id: crypto.randomUUID(),
        path: info.path,
        fileName: info.fileName,
        kind: isImage ? 'image' : kind === 'audio' ? 'audio' : 'video',
        sourceDurationSec: srcDur,
        sourceWidth: info.width ?? 0,
        sourceHeight: info.height ?? 0,
        hasAudio: !isImage && info.hasAudio,
        startSec: at,
        inSec: 0,
        outSec: len,
        volume: 1,
        mute: false,
        x: 0.5,
        y: 0.5,
        scale: isImage ? 0.25 : 0.4,
        opacity: 1,
        anim: { x: [], y: [], scale: [], opacity: [], volume: [] },
      });
      at += len;
    }
    if (added.length === 0) return;
    update((p) => ({
      ...p,
      tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, clips: [...t.clips, ...added] } : t)),
    }));
    const first = added[0];
    if (first) selectTrackClip({ trackId, clipId: first.id });
  };

  // ----- 구간 선택·삭제, 다중 선택, 트림, 재생 헤드 (모두 실행 취소 가능) -----
  const range: TimeRange | null = rangeSel ? normalizeRange(rangeSel.a, rangeSel.b, total) : null;
  const clearSelection = (): void => {
    setRangeSel(null);
    setPicked(new Set());
  };
  const setInPoint = (): void => setRangeSel((r) => ({ a: playhead, b: r?.b ?? playhead }));
  const setOutPoint = (): void => setRangeSel((r) => ({ a: r?.a ?? playhead, b: playhead }));
  const cutRange = (): void => {
    if (!range) return;
    update((p) => ({
      ...p,
      clips: cutOut(p.clips, range, () => crypto.randomUUID()),
      tracks: cutOutTracks(p.tracks, range, () => crypto.randomUUID()),
    }));
    setRangeSel(null);
    setPlayhead(range.startSec);
  };
  const keepRange = (): void => {
    if (!range) return;
    update((p) => ({
      ...p,
      clips: keepOnly(p.clips, range, () => crypto.randomUUID()),
      tracks: keepOnlyTracks(p.tracks, range, () => crypto.randomUUID()),
    }));
    setRangeSel(null);
    setPlayhead(0);
  };
  const removeClips = (ids: ReadonlySet<string>): void => {
    update((p) => ({ ...p, clips: p.clips.filter((c) => !ids.has(c.id)) }));
    if (selectedClip && ids.has(selectedClip)) setSelectedClip(null);
    setPicked(new Set());
  };
  /** 구간이 있으면 구간 삭제, 없으면 고른 클립(여러 개 가능) 삭제 */
  const deleteSelection = (): void => {
    if (range) {
      cutRange();
      return;
    }
    if (selTrack) {
      removeTrackClip(selTrack);
      return;
    }
    if (picked.size > 0) {
      removeClips(picked);
      return;
    }
    if (selectedClip) removeClips(new Set([selectedClip]));
  };
  /** 화면 x 좌표를 타임라인 시각(초)으로 바꾼다. 가로 스크롤과 여백을 반영한다. */
  const timeAt = (clientX: number): number => {
    const r = innerRef.current?.getBoundingClientRect();
    const t = r ? (clientX - r.left) / pxPerSec : 0;
    return Math.min(total, Math.max(0, t));
  };
  const snapped = (t: number): number =>
    snapTime(t, [...boundaryTimes(clips), ...trackBoundaryTimes(tracks)], 6 / pxPerSec);
  /** 포인터를 붙잡지 않는다. 붙잡으면 클릭이 클립이 아니라 바깥 요소로 가서 선택이 깨진다. */
  const beginDrag = (d: DragState): void => {
    setPlaying(false);
    dragRef.current = d;
  };
  /** 재생·정지. 끝에서 누르면 처음부터 재생한다. */
  const togglePlay = (): void => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (clips.length === 0) return;
    setPlayFrom(playhead >= total - 0.05 ? 0 : playhead);
    setPlayEnd(null);
    setPlaying(true);
  };
  const onPointerMove = (x: number): void => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'tmove' || d.kind === 'ttrim') {
      const dx = x - d.startX;
      if (!d.moved && Math.abs(dx) < 3) return;
      d.moved = true;
      if (d.kind === 'tmove') {
        // 끌고 있는 클립 자신의 경계에는 붙지 않게 뺀다
        const others = tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== d.id) }));
        const points = [...boundaryTimes(clips), ...trackBoundaryTimes(others), playhead];
        const ns = snapTime(d.base.startSec + dx / pxPerSec, points, 6 / pxPerSec);
        updateTrackClip(d.trackId, d.id, (c) => moveTrackClip(c, ns), `tmove:${d.id}`);
      } else {
        const base = d.base;
        const edge = d.edge;
        updateTrackClip(
          d.trackId,
          d.id,
          () => trimTrackClip(base, edge, dx / pxPerSec),
          `ttrim:${d.id}:${d.edge}`,
        );
      }
      return;
    }
    if (d.kind === 'trim') {
      const delta = (x - d.startX) / pxPerSec;
      update(
        (p) => ({
          ...p,
          clips: p.clips.map((c) => (c.id === d.id ? trimEdge(d.base, d.edge, delta) : c)),
        }),
        `trim:${d.id}:${d.edge}`,
      );
      return;
    }
    if (Math.abs(x - d.startX) > 3) d.moved = true;
    const t = snapped(timeAt(x));
    if (d.kind === 'scrub') setPlayhead(t);
    else setRangeSel({ a: d.anchorSec, b: t });
  };
  const onPointerUp = (x: number, y: number): void => {
    const d = dragRef.current;
    dragRef.current = null;
    // 트랙 클립을 같은 종류의 다른 트랙 위에 놓으면 그 트랙으로 옮긴다 (이동과 같은 실행 취소 단계)
    if (d && d.kind === 'tmove' && d.moved && Number.isFinite(x) && Number.isFinite(y)) {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-track-id]');
      const target = row?.dataset['trackId'];
      if (target && target !== d.trackId) {
        const id = d.id;
        const from = d.trackId;
        update(
          (p) => ({ ...p, tracks: moveClipToTrack(p.tracks, from, target, id) }),
          `tmove:${id}`,
        );
        const moved = projRef.current?.tracks
          .find((t) => t.id === target)
          ?.clips.some((c) => c.id === id);
        if (moved) setSelTrack({ trackId: target, clipId: id });
      }
    }
    // 눈금을 움직이지 않고 떼면 구간을 지우고 재생 헤드만 옮긴다
    if (d && d.kind === 'range' && !d.moved) {
      setRangeSel(null);
      setPlayhead(d.anchorSec);
    }
  };

  // 끌기 중의 이동과 놓기는 창 전체에서 받는다. 최신 핸들러는 렌더 후에 갱신한다.
  const dragHandlers = useRef({
    move: (_x: number): void => {},
    up: (_x: number, _y: number): void => {},
  });
  useEffect(() => {
    dragHandlers.current = { move: onPointerMove, up: onPointerUp };
  });
  useEffect(() => {
    const move = (e: PointerEvent): void => dragHandlers.current.move(e.clientX);
    const up = (e: PointerEvent): void => dragHandlers.current.up(e.clientX, e.clientY);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  // 편집 단축키: I·O 구간 지정, Delete 삭제, S 분할, 화살표 프레임 이동, Home·End, Esc 선택 해제.
  // 입력칸에서는 동작하지 않는다. 등록은 렌더마다 다시 하므로 항상 최신 상태를 본다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!projRef.current || e.altKey) return;
      if (e.ctrlKey || e.metaKey) {
        // 복사·붙여넣기·복제 (실행 취소 Ctrl+Z 는 위의 별도 등록에서 처리한다)
        const ck = e.key.toLowerCase();
        if (ck === 'c') {
          e.preventDefault();
          if (selectedClip) copyClip(selectedClip);
        } else if (ck === 'v') {
          e.preventDefault();
          pasteClip();
        } else if (ck === 'd') {
          e.preventDefault();
          if (selectedClip) duplicateClip(selectedClip);
        }
        return;
      }
      const k = e.key;
      if (k === ' ') {
        // 버튼에 초점이 있어도 버튼을 누르지 않고 재생만 바꾼다
        e.preventDefault();
        togglePlay();
        return;
      }
      if (k === 'k' || k === 'K') {
        setPlaying(false);
        return;
      }
      if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') setPlaying(false);
      if (k === 'i' || k === 'I') {
        e.preventDefault();
        setInPoint();
      } else if (k === 'o' || k === 'O') {
        e.preventDefault();
        setOutPoint();
      } else if (k === 'Delete' || k === 'Backspace') {
        e.preventDefault();
        deleteSelection();
      } else if (k === 'Escape') {
        clearSelection();
      } else if (k === 's' || k === 'S') {
        e.preventDefault();
        splitAtPlayhead();
      } else if (k === 'f' || k === 'F') {
        e.preventDefault();
        freezeSelected();
      } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        const fps = projRef.current.canvas.fps;
        const frame = 1 / (typeof fps === 'number' ? fps : 30);
        const step = (e.shiftKey ? 1 : frame) * (k === 'ArrowLeft' ? -1 : 1);
        setPlayhead((t) => moveTime(t, total, step));
      } else if (k === 'Home') {
        setPlayhead(0);
      } else if (k === 'End') {
        setPlayhead(total);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!project) {
    return (
      <div className="flex h-full flex-col gap-3 p-4 text-sm">
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => void createProject()}>
            새 프로젝트
          </Button>
          <Button onClick={() => void openKcp()}>.kcp 파일 열기</Button>
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
  const selClip = clips.find((c) => c.id === selectedClip) ?? null;
  const selTrackInfo = (() => {
    if (!selTrack) return null;
    const track = tracks.find((t) => t.id === selTrack.trackId);
    const clip = track?.clips.find((c) => c.id === selTrack.clipId);
    return track && clip ? { track, clip } : null;
  })();
  const rendering = render?.status === 'running';

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} entries={menu.entries} />
      )}
      {/* 상단 바 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--c-border)] px-3 py-2">
        <Button
          onClick={() => {
            setPlaying(false);
            projRef.current = null;
            setProject(null);
            void refreshList();
          }}
        >
          ← 프로젝트 목록
        </Button>
        <Button onClick={doUndo} disabled={histCount.u === 0} aria-label="실행 취소">
          실행 취소
        </Button>
        <Button onClick={doRedo} disabled={histCount.r === 0} aria-label="다시 실행">
          다시 실행
        </Button>
        <input
          aria-label="프로젝트 이름"
          className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] px-2 py-1 font-medium"
          value={project.name}
          onChange={(e) => update((p) => ({ ...p, name: e.target.value }), 'name')}
        />
        <Button variant="primary" onClick={() => void addClips()}>
          클립 추가
        </Button>
        <Button onClick={splitAtPlayhead} disabled={!at}>
          재생 헤드에서 분할
        </Button>
        <Button onClick={() => void saveKcp()} aria-label="프로젝트 파일 저장">
          .kcp 저장
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
          <div
            ref={previewBoxRef}
            className="relative flex min-h-0 flex-1 items-center justify-center bg-black"
          >
            <Button
              className="absolute right-2 top-2 z-30"
              onClick={fullscreenPreview}
              aria-label="미리보기 전체 화면"
            >
              전체 화면
            </Button>
            {playing && clips.length > 0 ? (
              <>
                <TimelinePreview
                  key={playFrom}
                  project={project}
                  startSec={playFrom}
                  endSec={playEnd}
                  onTime={setPlayhead}
                  onEnded={(t) => {
                    setPlaying(false);
                    setPlayhead(t);
                  }}
                  onError={(m) => {
                    setPlaying(false);
                    notify('error', m);
                  }}
                />
                <span className="absolute bottom-2 left-2 z-20 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                  근사 미리보기 · 손떨림 보정·선명·노이즈 제거·전환 모양은 내보내기에서만 반영됩니다
                </span>
              </>
            ) : render?.status === 'done' && render.previewId ? (
              <div className="max-h-full w-full max-w-4xl overflow-auto p-2">
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
              <Button
                variant={playing ? 'primary' : 'ghost'}
                aria-label={playing ? '미리보기 정지' : '미리보기 재생'}
                onClick={togglePlay}
                disabled={clips.length === 0}
              >
                {playing ? '■ 정지 (Space)' : '▶ 재생 (Space)'}
              </Button>
              <Button
                onClick={() => jumpBy(-5)}
                disabled={clips.length === 0}
                aria-label="5초 뒤로"
              >
                ◀ 5초
              </Button>
              <Button
                onClick={() => jumpBy(5)}
                disabled={clips.length === 0}
                aria-label="5초 앞으로"
              >
                5초 ▶
              </Button>
              <Button onClick={playRange} disabled={!range} aria-label="선택 구간만 재생">
                구간만 재생
              </Button>
              <label className="flex items-center gap-1">
                재생 헤드
                <input
                  type="range"
                  aria-label="재생 헤드"
                  min={0}
                  max={Math.max(0.1, total)}
                  step={0.05}
                  value={Math.min(playhead, total)}
                  onChange={(e) => {
                    setPlaying(false);
                    setPlayhead(Number(e.target.value));
                  }}
                  className="w-64"
                />
                <span className="w-16 tabular-nums">{playhead.toFixed(2)}초</span>
              </label>
              <Button onClick={zoomFit} aria-label="화면에 맞추기">
                화면에 맞추기
              </Button>
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
            {selClip && (
              <FilmStrip
                key={`${selClip.path}|${selClip.inSec}|${selClip.outSec}`}
                clip={selClip}
              />
            )}
            {/* 구간 도구 */}
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
              <Button onClick={setInPoint} aria-label="구간 시작을 재생 헤드 위치로">
                시작 (I)
              </Button>
              <Button onClick={setOutPoint} aria-label="구간 끝을 재생 헤드 위치로">
                끝 (O)
              </Button>
              {range ? (
                <>
                  <span className="tabular-nums">
                    구간 {formatDuration(range.startSec)} – {formatDuration(range.endSec)} (
                    {(range.endSec - range.startSec).toFixed(2)}초)
                  </span>
                  <Button variant="danger" onClick={cutRange}>
                    구간 삭제 (Delete)
                  </Button>
                  <Button onClick={keepRange}>구간만 남기기</Button>
                </>
              ) : (
                <span className="text-[var(--c-muted)]">
                  눈금을 끌어 구간을 고르거나 I·O 키로 지정합니다. 클립은 Ctrl+클릭으로 여러 개
                  고릅니다.
                </span>
              )}
              {(rangeSel !== null || picked.size > 0) && (
                <Button onClick={clearSelection}>선택 해제 (Esc)</Button>
              )}
              {picked.size > 1 && (
                <Button variant="danger" onClick={() => removeClips(picked)}>
                  고른 클립 {picked.size}개 삭제
                </Button>
              )}
              <span className="ml-auto flex gap-1">
                <Button onClick={() => addTrack('video')} disabled={tracks.length >= 20}>
                  + 영상 트랙
                </Button>
                <Button onClick={() => addTrack('audio')} disabled={tracks.length >= 20}>
                  + 오디오 트랙
                </Button>
              </span>
            </div>
            <div
              ref={trackBoxRef}
              className="overflow-x-auto rounded border border-[var(--c-border)] bg-[var(--c-surface-2)]"
              role="group"
              aria-label="타임라인 편집 영역"
            >
              <div
                ref={innerRef}
                className="relative select-none"
                style={{ width: Math.max(200, total * pxPerSec + 40) }}
              >
                {/* 눈금: 끌면 구간을 고르고, 가볍게 누르면 재생 헤드를 옮긴다 */}
                <div
                  data-testid="timeline-ruler"
                  className="relative h-6 cursor-pointer border-b border-[var(--c-border)] text-[10px] text-[var(--c-muted)]"
                  onPointerDown={(e) => {
                    const t = snapped(timeAt(e.clientX));
                    beginDrag({ kind: 'range', anchorSec: t, startX: e.clientX, moved: false });
                  }}
                >
                  {rulerTicks(total, pxPerSec).map((t) => (
                    <span
                      key={t}
                      className="absolute top-0 h-full border-l border-[var(--c-border)] pl-0.5"
                      style={{ left: t * pxPerSec }}
                    >
                      {formatDuration(t)}
                    </span>
                  ))}
                </div>
                {/* 트랙: 빈 곳을 누르면 재생 헤드가 움직이고, 여기에 놓은 클립은 순서가 바뀐다 */}
                <div
                  role="list"
                  aria-label="타임라인"
                  className="relative h-24"
                  onPointerDown={(e) =>
                    beginDrag({ kind: 'scrub', startX: e.clientX, moved: false })
                  }
                  onDragOver={(e) => {
                    if (dragClip.current) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragClip.current;
                    dragClip.current = null;
                    if (!from) return;
                    const to = dropIndexAt(clips, starts, timeAt(e.clientX) * pxPerSec, pxPerSec);
                    update((p) => reorderClip(p, from, to));
                  }}
                >
                  {clips.map((c, i) => {
                    const s = starts[i] ?? 0;
                    const d = clipDur(c);
                    const tr = transitionSec(c, clips[i + 1]);
                    const active = c.id === selectedClip;
                    const isPicked = picked.has(c.id);
                    return (
                      <div
                        key={c.id}
                        role="listitem"
                        aria-label={`클립 ${String(i + 1)}: ${c.fileName}`}
                        aria-selected={active}
                        draggable
                        onDragStart={(e) => {
                          // 가장자리를 조절하는 중에는 클립 끌기를 시작하지 않는다
                          if (dragRef.current?.kind === 'trim') {
                            e.preventDefault();
                            return;
                          }
                          dragClip.current = c.id;
                          e.dataTransfer.effectAllowed = 'move';
                          e.dataTransfer.setData('text/plain', c.id);
                        }}
                        onDragEnd={() => {
                          dragClip.current = null;
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setSelectedClip(c.id);
                          setPicked(new Set());
                          setSelTrack(null);
                          setMenu({
                            x: e.clientX,
                            y: e.clientY,
                            entries: clipMenuEntries(c.id),
                          });
                        }}
                        onClick={(e) => {
                          if (e.ctrlKey || e.metaKey) {
                            setPicked((prev) => {
                              // 지금 선택한 클립도 고른 목록에 포함시킨 뒤 토글한다
                              const n = new Set(
                                prev.size === 0 && selectedClip ? [selectedClip] : prev,
                              );
                              if (n.has(c.id)) n.delete(c.id);
                              else n.add(c.id);
                              return n;
                            });
                            return;
                          }
                          setPicked(new Set());
                          setSelTrack(null);
                          setSelectedClip(c.id);
                          setPanel('clip');
                        }}
                        title={`${c.fileName} ${c.inSec.toFixed(2)}–${c.outSec.toFixed(2)}초 ×${String(c.speed)}`}
                        className={`absolute top-2 flex h-14 cursor-pointer flex-col justify-between overflow-hidden rounded border px-1 py-0.5 text-xs ${active ? 'border-[var(--c-accent)] bg-[var(--c-accent)] text-[var(--c-accent-text)]' : 'border-[var(--c-border)] bg-[var(--c-surface)]'} ${isPicked ? 'ring-2 ring-amber-400' : ''}`}
                        style={{ left: s * pxPerSec, width: Math.max(24, d * pxPerSec) }}
                      >
                        <div
                          className="absolute inset-y-0 left-0 w-2 cursor-ew-resize hover:bg-white/40"
                          title="시작 조절 (끌면 잔물결로 줄어든다)"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            beginDrag({
                              kind: 'trim',
                              id: c.id,
                              edge: 'in',
                              base: c,
                              startX: e.clientX,
                            });
                          }}
                        />
                        <div
                          className="absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-white/40"
                          title="끝 조절 (끌면 잔물결로 줄어든다)"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            beginDrag({
                              kind: 'trim',
                              id: c.id,
                              edge: 'out',
                              base: c,
                              startX: e.clientX,
                            });
                          }}
                        />
                        {c.hasAudio && !c.mute && (
                          <Waveform
                            path={c.path}
                            fromSec={c.inSec}
                            toSec={c.outSec}
                            width={Math.max(24, d * pxPerSec)}
                            height={22}
                            className="bottom-0"
                          />
                        )}
                        {active &&
                          motionTimes(c).map((t) => (
                            <span
                              key={t}
                              aria-hidden
                              data-testid="motion-mark"
                              className="absolute top-0 h-2 w-2 -translate-x-1/2 rotate-45 bg-amber-500"
                              style={{ left: t * pxPerSec }}
                            />
                          ))}
                        <ClipThumbs clip={c} widthPx={Math.max(24, d * pxPerSec)} />
                        <span className="relative truncate font-medium">
                          {clipLabel(c)}
                          {c.still ? ' · 고정' : ''}
                        </span>
                        <span className="relative truncate">
                          {formatDuration(d)}
                          {c.speed !== 1 ? ` ×${String(c.speed)}` : ''}
                          {c.stabilize ? ' · 보정' : ''}
                          {c.hdr
                            ? ' · HDR'
                            : c.bitDepth !== undefined && c.bitDepth !== null && c.bitDepth > 8
                              ? ` · ${String(c.bitDepth)}비트`
                              : ''}
                          {c.texts.length > 0 ? ` · T${String(c.texts.length)}` : ''}
                          {tr > 0
                            ? ` · ${TRANSITION_LABELS[c.transition.type].split(' ')[0] ?? ''}`
                            : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {project.music && (
                  <MusicRow music={project.music} total={total} pxPerSec={pxPerSec} />
                )}
                <TrackRows
                  tracks={tracks}
                  pxPerSec={pxPerSec}
                  selected={selTrack}
                  onSelect={selectTrackClip}
                  onBeginMove={(trackId, c, clientX) =>
                    beginDrag({
                      kind: 'tmove',
                      trackId,
                      id: c.id,
                      base: c,
                      startX: clientX,
                      moved: false,
                    })
                  }
                  onBeginTrim={(trackId, c, edge, clientX) =>
                    beginDrag({
                      kind: 'ttrim',
                      trackId,
                      id: c.id,
                      edge,
                      base: c,
                      startX: clientX,
                      moved: false,
                    })
                  }
                  onAdd={(trackId, kind) => void addTrackMedia(trackId, kind)}
                  onToggle={toggleTrack}
                  onRemove={removeTrack}
                />
                {/* 모든 행에 걸친 구간 표시와 재생 헤드 */}
                {range && (
                  <div
                    className="pointer-events-none absolute bottom-0 top-6 z-10"
                    style={{
                      left: range.startSec * pxPerSec,
                      width: (range.endSec - range.startSec) * pxPerSec,
                      background: 'rgba(59,130,246,0.25)',
                    }}
                    aria-hidden
                  />
                )}
                <div
                  className="pointer-events-none absolute bottom-0 top-0 z-30 w-0.5 bg-[var(--c-danger)]"
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
            (selTrackInfo ? (
              <TrackClipPanel
                key={selTrackInfo.clip.id}
                track={selTrackInfo.track}
                clip={selTrackInfo.clip}
                playhead={playhead}
                onChange={(fn, key) =>
                  updateTrackClip(selTrackInfo.track.id, selTrackInfo.clip.id, fn, key)
                }
                onRemove={() =>
                  removeTrackClip({ trackId: selTrackInfo.track.id, clipId: selTrackInfo.clip.id })
                }
                onSeek={(t) => {
                  setPlaying(false);
                  setPlayhead(t);
                }}
              />
            ) : current ? (
              <>
                <ClipPanel
                  clip={current}
                  index={clips.findIndex((c) => c.id === current.id)}
                  count={clips.length}
                  playheadSource={at && clips[at.index]?.id === current.id ? at.sourceSec : null}
                  onChange={(patch) => updateClip(current.id, patch)}
                  onMove={(d) => moveClip(current.id, d)}
                  onRemove={() => removeClip(current.id)}
                  onDuplicate={() => duplicateClip(current.id)}
                  onSplitEqual={(n) => splitEqual(current.id, n)}
                  onSplitInterval={(sec) => splitInterval(current.id, sec)}
                />
                <MotionPanel
                  key={`motion-${current.id}`}
                  clip={current}
                  localSec={
                    at && clips[at.index]?.id === current.id
                      ? (at.sourceSec - current.inSec) / current.speed
                      : null
                  }
                  onChange={(fn, key) =>
                    update(
                      (p) => ({
                        ...p,
                        clips: p.clips.map((c) => (c.id === current.id ? fn(c) : c)),
                      }),
                      key,
                    )
                  }
                  onSeek={(local) => {
                    const idx = clips.findIndex((c) => c.id === current.id);
                    setPlaying(false);
                    setPlayhead((starts[idx] ?? 0) + local);
                  }}
                />
              </>
            ) : (
              <p className="text-xs text-[var(--c-muted)]">타임라인에서 클립을 선택하세요.</p>
            ))}
          {panel === 'project' && <ProjectPanel project={project} onChange={update} />}
          {panel === 'export' && (
            <ExportPanel
              project={project}
              render={render}
              onLosslessCheck={losslessCheck}
              onLosslessMerge={() => void losslessMerge()}
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
  onSplitEqual,
  onSplitInterval,
}: {
  clip: EditClip;
  index: number;
  count: number;
  playheadSource: number | null;
  onChange: (patch: Partial<EditClip> | ((c: EditClip) => EditClip)) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onSplitEqual: (n: number) => void;
  onSplitInterval: (seconds: number) => void;
}): ReactNode {
  const [interval, setInterval_] = useState(5);
  const [parts, setParts] = useState(2);
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
        <span className="flex items-center gap-1 text-xs">
          <input
            type="number"
            aria-label="나눌 조각 수"
            min={2}
            max={10}
            value={parts}
            onChange={(e) => setParts(Math.round(Number(e.target.value)))}
            className="w-14 rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
          />
          <Button onClick={() => onSplitEqual(parts)}>같은 길이로 나누기</Button>
        </span>
        <span className="flex items-center gap-1 text-xs">
          <input
            type="number"
            aria-label="나눌 간격(초)"
            min={0.2}
            step={1}
            value={interval}
            onChange={(e) => setInterval_(Number(e.target.value))}
            className="w-16 rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1"
          />
          <Button onClick={() => onSplitInterval(interval)}>간격으로 나누기</Button>
        </span>
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

      <h4 className="mt-3 text-xs font-semibold text-[var(--c-muted)]">이름·길이·페이드</h4>
      <label className="mt-1 flex items-center justify-between gap-2 text-xs">
        표시 이름
        <input
          aria-label="표시 이름"
          className="w-40 rounded border border-[var(--c-border)] bg-[var(--c-surface)] px-1 py-0.5"
          placeholder={clip.fileName}
          value={clip.label ?? ''}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </label>
      <Num
        label={clip.still ? '고정 길이 (초)' : '길이 (초, 배속 반영)'}
        value={Number(clipDur(clip).toFixed(2))}
        min={0.1}
        step={0.1}
        onChange={(v) =>
          onChange((c) =>
            c.still
              ? { ...c, stillSec: Math.max(0.1, v) }
              : {
                  ...c,
                  outSec: Math.min(c.sourceDurationSec, c.inSec + Math.max(0.1, v) * c.speed),
                },
          )
        }
      />
      <Range
        label="페이드 인 (초)"
        min={0}
        max={Number(maxFadeSec(clipDur(clip)).toFixed(2))}
        step={0.1}
        value={clip.fadeInSec ?? 0}
        onChange={(v) => onChange({ fadeInSec: v })}
      />
      <Range
        label="페이드 아웃 (초)"
        min={0}
        max={Number(maxFadeSec(clipDur(clip)).toFixed(2))}
        step={0.1}
        value={clip.fadeOutSec ?? 0}
        onChange={(v) => onChange({ fadeOutSec: v })}
      />
      <h4 className="mt-3 text-xs font-semibold text-[var(--c-muted)]">소리 정리</h4>
      <label className="mt-1 flex items-center justify-between gap-2 text-xs">
        잡음 줄이기
        <select
          aria-label="잡음 줄이기"
          className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] px-1 py-0.5"
          value={clip.noiseReduce ?? 'off'}
          onChange={(e) => onChange({ noiseReduce: e.target.value as 'off' | 'light' | 'strong' })}
        >
          <option value="off">끔</option>
          <option value="light">약하게</option>
          <option value="strong">강하게</option>
        </select>
      </label>
      <label className="mt-1 flex items-center justify-between gap-2 text-xs">
        보컬 (좌우 채널)
        <select
          aria-label="보컬 처리"
          className="rounded border border-[var(--c-border)] bg-[var(--c-surface)] px-1 py-0.5"
          value={clip.vocal ?? 'off'}
          disabled={!vocalAvailability(clip.audioChannels).ok}
          onChange={(e) => onChange({ vocal: e.target.value as 'off' | 'reduce' | 'isolate' })}
        >
          <option value="off">그대로</option>
          <option value="reduce">보컬 줄이기 (가라오케)</option>
          <option value="isolate">가운데만 남기기 (보컬 위주)</option>
        </select>
      </label>
      {!vocalAvailability(clip.audioChannels).ok && (
        <p className="text-[10px] text-[var(--c-muted)]">
          {vocalAvailability(clip.audioChannels).reason}. 보컬 처리는 스테레오 원본에서만 됩니다.
        </p>
      )}
      <p className="text-[10px] text-[var(--c-muted)]">
        소리 정리는 내보내기에만 반영되고, 미리보기에는 반영되지 않습니다. 잡음 줄이기는 음성 전체에
        걸쳐 같은 강도로 적용되므로 목소리가 얇아질 수 있습니다.
      </p>
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
  onLosslessCheck,
  onLosslessMerge,
}: {
  project: EditProject;
  render: EditRenderProgress | null;
  onChange: (fn: (p: EditProject) => EditProject) => void;
  onCancel: () => void;
  onLosslessCheck: () => Promise<{ ok: boolean; reasons: string[] } | null>;
  onLosslessMerge: () => void;
}): ReactNode {
  const o = project.output;
  const chapters = chapterLines(project.clips).join('\n');
  const { tools } = useAppStore();
  const hw = tools?.hardwareEncoders.find((h) => h.codec === o.codec && h.available) ?? null;
  const highRange = project.clips.filter(
    (c) => c.hdr === true || (c.bitDepth !== undefined && c.bitDepth !== null && c.bitDepth > 8),
  );
  const [lossless, setLossless] = useState<{ ok: boolean; reasons: string[] } | null>(null);
  const setOut = (patch: Partial<EditProject['output']>): void =>
    onChange((p) => ({ ...p, output: { ...p.output, ...patch } }));
  return (
    <div>
      <h4 className="text-xs font-semibold text-[var(--c-muted)]">출력 설정</h4>
      {highRange.length > 0 && (
        <div role="alert" className="mt-1 rounded border border-[var(--c-danger)] p-2 text-xs">
          HDR·10비트 원본이 있습니다:{' '}
          {highRange
            .map((c) => `${c.fileName}${c.hdr ? ' (HDR)' : ` (${String(c.bitDepth)}비트)`}`)
            .join(', ')}
          . 결과는 SDR 8비트(BT.709)로 만들어지므로 색과 밝기가 달라집니다. 아래에 동의해야 내보낼
          수 있습니다.
        </div>
      )}
      <label className="mt-1 flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          aria-label="HDR·10비트 원본을 SDR 8비트로 변환"
          checked={o.hdrToSdr === true}
          onChange={(e) => setOut({ hdrToSdr: e.target.checked })}
        />
        <span>
          HDR·10비트 원본을 SDR 8비트로 변환해 내보내기 (HDR 은 톤 매핑). 동의하지 않으면 그런
          원본이 있을 때 내보내기를 멈춥니다.
        </span>
      </label>
      <label className="mt-1 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          aria-label="클립 사이 음량 맞추기"
          checked={o.normalizeAudio === true}
          onChange={(e) => setOut({ normalizeAudio: e.target.checked })}
        />
        클립 사이 음량 맞추기 (EBU R128, -16 LUFS. 미리보기에는 반영되지 않음)
      </label>
      <label className="mt-1 flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          aria-label="하드웨어 인코더 사용"
          checked={o.hardware === true}
          onChange={(e) => setOut({ hardware: e.target.checked })}
        />
        <span>
          하드웨어 인코더 사용 (
          {hw ? `${hw.name} 사용 가능` : '이 PC 에서 사용할 수 있는 인코더 없음'}). 실패하면 CPU
          인코더로 다시 렌더합니다. 품질 값은 CRF 대신 인코더별 기본값을 씁니다.
        </span>
      </label>
      <label className="mt-1 flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          aria-label="오디오 제외"
          checked={o.noAudio === true}
          onChange={(e) =>
            onChange((p) => ({ ...p, output: { ...p.output, noAudio: e.target.checked } }))
          }
        />
        오디오 제외 (영상만 내보내기)
      </label>
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

      <h4 className="mt-3 text-xs font-semibold text-[var(--c-muted)]">유튜브 챕터</h4>
      {project.clips.length === 0 ? (
        <p className="text-xs text-[var(--c-muted)]">클립을 추가하면 챕터 목록이 만들어집니다.</p>
      ) : (
        <div className="space-y-1">
          <textarea
            aria-label="챕터 텍스트"
            readOnly
            rows={Math.min(8, project.clips.length + 1)}
            className="w-full rounded border border-[var(--c-border)] bg-[var(--c-surface)] p-1 font-mono text-xs"
            value={chapters}
          />
          <Button
            onClick={() => {
              void navigator.clipboard
                .writeText(chapters)
                .then(() =>
                  notify('info', '챕터 텍스트를 복사했습니다. 유튜브 설명란에 붙여 넣으세요.'),
                )
                .catch(() =>
                  notify('error', '복사하지 못했습니다. 텍스트를 직접 선택해 복사하세요.'),
                );
            }}
          >
            챕터 텍스트 복사
          </Button>
          <p className="text-xs text-[var(--c-muted)]">
            시작 시간은 전환이 겹친 뒤의 타임라인 기준입니다. 유튜브는 첫 챕터가 0:00 이어야 합니다.
          </p>
        </div>
      )}

      <h4 className="mt-3 text-xs font-semibold text-[var(--c-muted)]">무손실 합치기</h4>
      <p className="text-xs text-[var(--c-muted)]">
        효과 없이 파일 전체를 잇고 형식이 모두 같으면 재인코딩 없이 몇 초 만에 합칩니다. 화질이
        그대로입니다.
      </p>
      <div className="mt-1 flex flex-wrap gap-1">
        <Button onClick={() => void onLosslessCheck().then((r) => setLossless(r))}>
          가능한지 확인
        </Button>
        <Button
          variant="primary"
          disabled={!lossless?.ok || render?.status === 'running'}
          onClick={onLosslessMerge}
        >
          무손실로 합치기
        </Button>
      </div>
      {lossless && (
        <div className="mt-1 text-xs" data-testid="lossless-result">
          {lossless.ok ? (
            <p>무손실로 합칠 수 있습니다.</p>
          ) : (
            <ul className="list-disc pl-4 text-[var(--c-muted)]">
              {lossless.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}

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
