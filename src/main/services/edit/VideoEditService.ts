/**
 * 영상 편집기: 프로젝트 관리, 소스 확인, 프레임 미리보기, 렌더(미리보기·내보내기).
 *
 * 원칙
 * - 원본 클립·음악·워터마크 파일은 읽기만 한다.
 * - 렌더는 임시 파일(.vslim-tmp-)에 만들고 ffprobe 로 길이·해상도·트랙을 확인한 뒤 새 이름으로 확정한다. 덮어쓰지 않는다.
 * - 진행률은 FFmpeg -progress 의 실제 값으로만 계산한다. 손떨림 분석 패스는 단계별로 비율을 나눈다.
 * - 미리보기 렌더(proxy)는 640px 저화질이며 "미리보기"로만 표시한다. 내보내기 결과가 아니다.
 */
import { randomUUID } from 'node:crypto';
import { displaySize } from '../../../shared/displayDims';
import { decodeSubtitle, sniffEncoding } from '../ExternalSubtitleService';
import { DISPLAY_SUBTITLE_MAX_BYTES, formatOfExtension } from '../library/LibrarySubtitles';
import { keepOnly, keepOnlyTracks, type TimeRange } from '../../../shared/timelineCut';
import { missingRefs, replaceSourcePath, type MissingRef } from '../../../shared/relink';
import fs from 'node:fs';
import path from 'node:path';
import type {
  HardwareEncoderStatus,
  EditProject,
  EditProjectSummary,
  EditRenderMode,
  EditRenderProgress,
  EditSourceInfo,
  ImageExportTarget,
} from '../../../shared/types/domain';
import type { EditProjectRepository } from '../../repositories/EditProjectRepository';
import type { LibraryRepository } from '../../repositories/LibraryRepository';
import type { Logger } from '../../platform/logger';
import { AppError } from '../AppError';
import type { FFmpegProcessService } from '../FFmpegProcessService';
import {
  finalizeFile,
  isAppTempFile,
  removeAppTempFile,
  resolveFinalPath,
  tempOutputPath,
} from '../FileFinalizeService';
import type { ToolPaths } from '../JobRunner';
import type { MediaProbeService } from '../MediaProbeService';
import { ProgressEstimator } from '../ProgressEstimator';
import { mimeOf, type MediaTokenRegistry } from '../library/MediaTokenRegistry';
import {
  compatibilityReasons,
  losslessArgs,
  losslessProjectBlockers,
  signatureOf,
  type StreamSignature,
} from './losslessMerge';
import { buildConcatListText } from '../library/ClipCutService';
import {
  conversionWarnings,
  isHdrTransfer,
  supportsTonemap,
  type SourceColor,
} from './sourceColor';
import {
  computePeaks,
  WAVE_MAX_SEC,
  WAVE_PEAKS_PER_SEC,
  WAVE_SAMPLE_RATE,
  type WaveformData,
} from './waveform';
import type { ThumbnailService } from '../library/ThumbnailService';
import {
  buildRenderPlan,
  clipDurationSec,
  outputArgs,
  type EditHwEncoder,
  projectDurationSec,
  proxyCanvas,
  resolveCanvas,
  type RenderPlan,
} from './EditGraphBuilder';

export interface VideoEditDeps {
  repo: EditProjectRepository;
  library: LibraryRepository;
  probe: MediaProbeService;
  proc: FFmpegProcessService;
  tools: () => ToolPaths;
  thumbs: ThumbnailService;
  tokens: MediaTokenRegistry;
  /** 미리보기 렌더 결과를 둘 디렉터리 (userData/previews 와 같은 곳) */
  previewDir: string;
  tempRoot: string;
  logger: Logger;
  emit: (p: EditRenderProgress) => void;
  /** 내보내기 결과를 라이브러리에 반영 */
  indexFile: (filePath: string) => Promise<string | null>;
  /** drawtext 글꼴 파일 탐색 (null = fontconfig) */
  fontFile: () => string | null;
  /** 하드웨어 인코더 검사 결과 (도구 확인 때 채워진다) */
  hardwareStatuses: () => HardwareEncoderStatus[];
  now?: () => Date;
}

const RENDER_STALL_MS = 10 * 60_000;

/** Windows 의 한글 글꼴부터 찾고, 없으면 리눅스의 흔한 CJK 글꼴, 그래도 없으면 null (fontconfig 'Sans') */
export function findDefaultFont(platform: NodeJS.Platform = process.platform): string | null {
  const candidates =
    platform === 'win32'
      ? [
          'C:\\Windows\\Fonts\\malgun.ttf',
          'C:\\Windows\\Fonts\\gulim.ttc',
          'C:\\Windows\\Fonts\\arial.ttf',
        ]
      : [
          '/usr/share/fonts/truetype/nanum/NanumGothic.ttf',
          '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
          '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
          '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export function newProject(name: string, at: string): EditProject {
  return {
    id: randomUUID(),
    name,
    clips: [],
    music: null,
    watermark: null,
    canvas: { preset: 'auto', fps: 'auto' },
    output: { container: 'mp4', codec: 'h264', crf: 20, preset: 'medium' },
    tracks: [],
    createdAt: at,
    updatedAt: at,
  };
}

/** 구간 밖을 잘라낸 프로젝트 복사본 (저장하지 않는다) */
export function keepRangeProject(
  p: EditProject,
  r: { startSec: number; endSec: number },
): EditProject {
  const range: TimeRange = { startSec: r.startSec, endSec: r.endSec };
  const newId = (): string => randomUUID();
  return {
    ...p,
    clips: keepOnly(p.clips, range, newId),
    tracks: keepOnlyTracks(p.tracks, range, newId),
  };
}

export class VideoEditService {
  private readonly running = new Map<string, AbortController>();

  constructor(private readonly deps: VideoEditDeps) {
    fs.mkdirSync(deps.previewDir, { recursive: true });
  }

  // ----- 프로젝트 -----

  list(): EditProjectSummary[] {
    return this.deps.repo.list((p) => ({
      clipCount: p.clips.length,
      durationSec: projectDurationSec(p),
    }));
  }

  create(name: string): EditProject {
    const p = newProject(name.trim() || '새 프로젝트', this.now());
    this.deps.repo.insert(p);
    return p;
  }

  get(id: string): EditProject {
    const p = this.deps.repo.get(id);
    if (!p) throw new AppError('INVALID_REQUEST', '프로젝트를 찾을 수 없습니다');
    return p;
  }

  save(project: EditProject): EditProject {
    // 클립 구간이 원본 안에 있고 시작 < 끝인지 확인한다 (화면 값은 신뢰하지 않는다)
    for (const c of project.clips) {
      if (c.outSec <= c.inSec)
        throw new AppError('INVALID_REQUEST', `${c.fileName}: 끝 시점이 시작보다 커야 합니다`);
      if (c.outSec > c.sourceDurationSec + 0.05)
        throw new AppError('INVALID_REQUEST', `${c.fileName}: 끝 시점이 원본 길이를 넘습니다`);
    }
    for (const t of project.tracks) {
      for (const c of t.clips) {
        if (c.outSec <= c.inSec)
          throw new AppError('INVALID_REQUEST', `${c.fileName}: 끝 시점이 시작보다 커야 합니다`);
        if (c.outSec > c.sourceDurationSec + 0.05)
          throw new AppError('INVALID_REQUEST', `${c.fileName}: 끝 시점이 원본 길이를 넘습니다`);
      }
    }
    const next = { ...project, updatedAt: this.now() };
    if (!this.deps.repo.update(next))
      throw new AppError('INVALID_REQUEST', '프로젝트를 찾을 수 없습니다');
    return next;
  }

  /** .kcp 파일에서 읽은 프로젝트를 새 항목으로 저장한다 (기존 프로젝트를 덮어쓰지 않도록 새 ID 를 준다) */
  importProject(p: EditProject): { id: string; name: string } {
    const now = this.now();
    const next: EditProject = {
      ...p,
      id: randomUUID(),
      name: p.name.trim() || '가져온 프로젝트',
      createdAt: now,
      updatedAt: now,
    };
    this.deps.repo.insert(next);
    return { id: next.id, name: next.name };
  }

  delete(id: string): boolean {
    return this.deps.repo.delete(id);
  }

  // ----- 소스 -----

  async probeSource(filePath: string): Promise<EditSourceInfo> {
    const p = await this.deps.probe.probe(filePath);
    const v = p.streams.find((s) => s.kind === 'video' && !s.isAttachedPic) ?? null;
    const a = p.streams.find((s) => s.kind === 'audio') ?? null;
    const isImage =
      v !== null &&
      (p.durationSec.value === null ||
        p.formatName.includes('image2') ||
        p.formatName.includes('png_pipe') ||
        p.formatName.includes('webp'));
    const kind: EditSourceInfo['kind'] = isImage ? 'image' : v ? 'video' : a ? 'audio' : 'video';
    if (!v && !a) throw new AppError('UNSUPPORTED_INPUT', '영상도 음성도 없는 파일입니다');
    return {
      path: p.path,
      fileName: p.fileName,
      kind,
      durationSec: p.durationSec.value,
      // 화면에 보이는 방향의 크기 (휴대폰 회전 정보 반영)
      width: displaySize(v?.width ?? null, v?.height ?? null, v?.rotation).width,
      height: displaySize(v?.width ?? null, v?.height ?? null, v?.rotation).height,
      hasAudio: a !== null,
      hasVideo: v !== null,
      audioChannels: a?.channels ?? null,
      interlaced: v?.fieldOrder === 'interlaced',
      hdr: isHdrTransfer(v?.colorTransfer),
      bitDepth: v?.bitDepth ?? null,
    };
  }

  /** 원본 파일의 시점 프레임 (효과 미적용). 썸네일 캐시를 쓴다 */
  /** 자막 파일 읽기 (읽기 전용, 2MB 이하). 인코딩은 자동 판별한다. */
  readSubtitle(filePath: string): {
    fileName: string;
    format: 'srt' | 'webvtt' | 'ass' | 'ssa';
    text: string;
  } {
    const fileName = path.basename(filePath);
    const format = formatOfExtension(fileName);
    if (format === null)
      throw new AppError(
        'UNSUPPORTED_INPUT',
        '자막 파일은 SRT, VTT, ASS, SSA 만 가져올 수 있습니다',
      );
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch (err) {
      throw new AppError('INPUT_MISSING', filePath, { cause: err });
    }
    if (!st.isFile() || st.size > DISPLAY_SUBTITLE_MAX_BYTES)
      throw new AppError('UNSUPPORTED_INPUT', '자막 파일을 읽을 수 없거나 2MB 를 넘습니다');
    const buf = fs.readFileSync(filePath);
    return { fileName, format, text: decodeSubtitle(buf, sniffEncoding(buf)) };
  }

  /** 디스크에 없는 원본 참조 (역할별) */
  missingSources(projectId: string): MissingRef[] {
    return missingRefs(this.get(projectId), (p) => fs.existsSync(p));
  }

  /** 원본 파일을 새 파일로 다시 연결하고 저장한다 (같은 경로의 참조를 모두 바꾼다) */
  async relinkSource(
    projectId: string,
    oldPath: string,
    newPath: string,
  ): Promise<{ project: EditProject; warnings: string[] }> {
    const info = await this.probeSource(newPath);
    const base = this.get(projectId);
    const result = replaceSourcePath(base, oldPath, {
      path: info.path,
      fileName: info.fileName,
      durationSec: info.durationSec,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
      audioChannels: info.audioChannels,
      hdr: info.hdr,
      bitDepth: info.bitDepth,
    });
    const saved = this.save(result.project);
    return { project: saved, warnings: result.warnings };
  }

  /** 무손실 합치기 가능 여부. 안 되면 이유를 모두 돌려준다 */
  async losslessCheck(projectId: string): Promise<{ ok: boolean; reasons: string[] }> {
    const p = this.get(projectId);
    const reasons = losslessProjectBlockers(p);
    if (reasons.length > 0) return { ok: false, reasons };
    const sigs: StreamSignature[] = [];
    for (const c of p.clips) {
      if (!fs.existsSync(c.path)) return { ok: false, reasons: [`${c.fileName}: 파일이 없습니다`] };
      sigs.push(signatureOf(c.fileName, c.path, await this.deps.probe.probe(c.path)));
    }
    const more = compatibilityReasons(sigs);
    return { ok: more.length === 0, reasons: more };
  }

  /**
   * 재인코딩 없이 파일을 이어 붙인다 (concat 분리기, -c copy). 진행은 렌더와 같은 이벤트로 알린다.
   * 결과는 원본과 같은 형식이고, 원본은 읽기만 한다. 길이가 원본 합과 다르면 실패로 본다.
   */
  losslessMerge(projectId: string, target: ImageExportTarget | null): string {
    const project = this.get(projectId);
    const renderId = randomUUID();
    const controller = new AbortController();
    this.running.set(renderId, controller);
    const tempDir = path.join(this.deps.tempRoot, `edit-${renderId}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const emit = (patch: Partial<EditRenderProgress>): void =>
      this.deps.emit({
        renderId,
        projectId,
        mode: 'export',
        status: 'running',
        stage: '준비',
        ratio: null,
        etaSec: null,
        outputPath: null,
        previewId: null,
        error: null,
        ...patch,
      });
    emit({ stage: '무손실 합치기 확인' });
    void (async () => {
      let temp = '';
      try {
        const check = await this.losslessCheck(projectId);
        if (!check.ok) {
          throw new AppError(
            'INVALID_REQUEST',
            `무손실로 합칠 수 없습니다.\n${check.reasons.join('\n')}`,
          );
        }
        const first = project.clips[0] as EditProject['clips'][number];
        const ext = (first.path.split('.').pop() ?? 'mp4').toLowerCase();
        const outDir =
          target?.kind === 'path' ? path.dirname(target.path) : path.dirname(first.path);
        const baseName =
          target?.kind === 'path'
            ? path.parse(target.path).name
            : sanitizeName(project.name) + (target?.suffix ?? '-merge');
        if (!fs.existsSync(outDir))
          throw new AppError('INVALID_REQUEST', `폴더가 없습니다: ${outDir}`);
        temp = tempOutputPath(outDir, baseName, renderId, ext);
        removeAppTempFile(temp);
        const list = path.join(tempDir, 'concat.txt');
        fs.writeFileSync(list, buildConcatListText(project.clips.map((c) => c.path)), 'utf8');
        let expected = 0;
        let hasAudio = true;
        for (const c of project.clips) {
          const pr = await this.deps.probe.probe(c.path);
          expected += pr.durationSec.value ?? 0;
          if (!pr.streams.some((s) => s.kind === 'audio')) hasAudio = false;
        }
        emit({ stage: '무손실 합치기 (재인코딩 없음)' });
        const tools = this.deps.tools();
        const res = await this.deps.proc.run(
          tools.ffmpeg,
          losslessArgs(list, temp, ext, hasAudio),
          {
            jobId: `edit-${renderId}`,
            signal: controller.signal,
            stallTimeoutMs: RENDER_STALL_MS,
          },
        );
        if (res.cancelled) throw new AppError('CANCELLED');
        if (res.exitCode !== 0 || !fs.existsSync(temp)) {
          throw new AppError('ENCODE_FAILED', res.stderrTail.slice(-6).join('\n') || '합치기 실패');
        }
        emit({ stage: '검증', ratio: 1 });
        const out = await this.deps.probe.probe(temp);
        const got = out.durationSec.value ?? 0;
        if (Math.abs(got - expected) > Math.max(0.5, expected * 0.01)) {
          throw new AppError(
            'VALIDATION_FAILED',
            `합친 길이(${got.toFixed(2)}초)가 원본 합(${expected.toFixed(2)}초)과 다릅니다`,
          );
        }
        const finalPath = resolveFinalPath(outDir, baseName, ext, first.path);
        finalizeFile(temp, finalPath);
        try {
          await this.deps.indexFile(finalPath);
        } catch (err) {
          this.deps.logger.warn('indexing merge output failed', { finalPath, err: String(err) });
        }
        this.deps.logger.info('lossless merge done', {
          renderId,
          finalPath,
          clips: project.clips.length,
        });
        emit({
          status: 'done',
          stage: '완료 (무손실)',
          ratio: 1,
          etaSec: 0,
          outputPath: finalPath,
        });
      } catch (err) {
        const app = AppError.from(err);
        if (temp) removeAppTempFile(temp);
        if (app.code === 'CANCELLED') emit({ status: 'cancelled', stage: '취소됨' });
        else emit({ status: 'failed', stage: '실패', error: `${app.code}: ${app.detail ?? ''}` });
      } finally {
        this.running.delete(renderId);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    })();
    return renderId;
  }

  private tonemapOk: boolean | null = null;

  /** 원본 영상의 HDR 여부와 비트 깊이 (첫 영상 트랙 기준) */
  private async sourceColor(filePath: string): Promise<{ hdr: boolean; bitDepth: number | null }> {
    const p = await this.deps.probe.probe(filePath);
    const v = p.streams.find((s) => s.kind === 'video' && !s.isAttachedPic);
    return { hdr: isHdrTransfer(v?.colorTransfer), bitDepth: v?.bitDepth ?? null };
  }

  /** 이 FFmpeg 에 톤 매핑 필터가 있는지 (한 번만 확인) */
  private async canTonemap(): Promise<boolean> {
    if (this.tonemapOk !== null) return this.tonemapOk;
    const res = await this.deps.proc.run(this.deps.tools().ffmpeg, ['-hide_banner', '-filters'], {
      timeoutMs: 15_000,
      captureStdout: true,
    });
    this.tonemapOk = res.exitCode === 0 && supportsTonemap(res.stdout);
    return this.tonemapOk;
  }

  /** 파형 캐시 (경로·크기·수정 시각 기준, 최근 32개) */
  private readonly waveCache = new Map<string, WaveformData>();

  /**
   * 오디오 파형 피크. 음성이 없거나 읽지 못하면 빈 배열을 돌려준다 (편집은 계속할 수 있다).
   * 원본은 읽기만 하고, 중간 PCM 은 임시 폴더에 썼다가 지운다.
   */
  async waveform(filePath: string): Promise<WaveformData> {
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch (err) {
      throw new AppError('INPUT_MISSING', filePath, { cause: err });
    }
    if (!st.isFile()) throw new AppError('INPUT_UNREADABLE', filePath);
    const key = `${filePath}|${String(st.size)}|${String(st.mtimeMs)}`;
    const hit = this.waveCache.get(key);
    if (hit) return hit;
    fs.mkdirSync(this.deps.tempRoot, { recursive: true });
    const out = path.join(this.deps.tempRoot, `wave-${randomUUID()}.raw`);
    const empty: WaveformData = { peaksPerSec: WAVE_PEAKS_PER_SEC, peaks: [] };
    try {
      const tools = this.deps.tools();
      const res = await this.deps.proc.run(
        tools.ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          '-t',
          String(WAVE_MAX_SEC),
          '-i',
          filePath,
          '-map',
          '0:a:0',
          '-ac',
          '1',
          '-ar',
          String(WAVE_SAMPLE_RATE),
          '-acodec',
          'pcm_s16le',
          '-f',
          's16le',
          out,
        ],
        { timeoutMs: 180_000 },
      );
      if (res.exitCode !== 0 || !fs.existsSync(out)) return empty;
      const data: WaveformData = {
        peaksPerSec: WAVE_PEAKS_PER_SEC,
        peaks: computePeaks(fs.readFileSync(out), WAVE_SAMPLE_RATE, WAVE_PEAKS_PER_SEC),
      };
      this.waveCache.set(key, data);
      if (this.waveCache.size > 32) {
        const oldest = this.waveCache.keys().next().value;
        if (oldest !== undefined) this.waveCache.delete(oldest);
      }
      return data;
    } finally {
      fs.rmSync(out, { force: true });
    }
  }

  /**
   * 실시간 미리보기용 재생 주소. 영상·음성 파일만 토큰으로 연다 (파일은 읽기만 한다).
   */
  mediaUrl(filePath: string): { url: string } {
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch (err) {
      throw new AppError('INPUT_MISSING', filePath, { cause: err });
    }
    if (!st.isFile()) throw new AppError('INPUT_UNREADABLE', filePath);
    const mime = mimeOf(filePath);
    if (!mime.startsWith('video/') && !mime.startsWith('audio/'))
      throw new AppError('UNSUPPORTED_INPUT', '미리보기는 영상·음성 파일만 열 수 있습니다');
    return { url: this.deps.tokens.issue(`edit:media:${filePath}`, filePath, mime) };
  }

  async frame(filePath: string, timeSec: number): Promise<{ url: string }> {
    const st = fs.statSync(filePath);
    const file = await this.deps.thumbs.frame(
      { path: filePath, kind: 'video', sizeBytes: st.size, mtimeMs: st.mtimeMs, durationSec: null },
      timeSec,
    );
    const t = (Math.round(timeSec * 10) / 10).toFixed(1);
    return { url: this.deps.tokens.issue(`edit:frame:${filePath}:${t}`, file, 'image/jpeg') };
  }

  // ----- 렌더 -----

  render(
    projectId: string,
    mode: EditRenderMode,
    target: ImageExportTarget | null,
    range: { startSec: number; endSec: number } | null = null,
  ): string {
    // 구간만 내보내기: 구간 밖을 잘라낸 복사본으로 렌더한다 (저장된 프로젝트는 그대로)
    const saved = this.get(projectId);
    const project = range ? keepRangeProject(saved, range) : saved;
    if (project.clips.length === 0)
      throw new AppError('INVALID_REQUEST', '클립을 하나 이상 추가하세요');
    for (const c of project.clips) {
      if (!fs.existsSync(c.path)) throw new AppError('INPUT_MISSING', c.path);
      if (clipDurationSec(c) < 0.1)
        throw new AppError('INVALID_REQUEST', `${c.fileName}: 클립이 너무 짧습니다`);
    }
    if (project.music && !fs.existsSync(project.music.path))
      throw new AppError('INPUT_MISSING', project.music.path);
    if (project.watermark && !fs.existsSync(project.watermark.path))
      throw new AppError('INPUT_MISSING', project.watermark.path);

    const renderId = randomUUID();
    const controller = new AbortController();
    this.running.set(renderId, controller);
    const tempDir = path.join(this.deps.tempRoot, `edit-${renderId}`);
    fs.mkdirSync(path.join(tempDir, 'text'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'trf'), { recursive: true });

    const baseCanvas = resolveCanvas(project);
    const canvas = mode === 'proxy' ? proxyCanvas(baseCanvas) : baseCanvas;
    const ext = mode === 'proxy' ? 'mp4' : project.output.container;
    let outDir: string;
    let baseName: string;
    if (mode === 'proxy') {
      outDir = this.deps.previewDir;
      baseName = `edit-${renderId}`;
    } else if (target?.kind === 'path') {
      outDir = path.dirname(target.path);
      baseName = path.parse(target.path).name;
    } else {
      const first = project.clips[0] as EditProject['clips'][number];
      outDir = path.dirname(first.path);
      baseName = sanitizeName(project.name) + (target?.suffix ?? '-edit');
    }
    if (!fs.existsSync(outDir)) throw new AppError('INVALID_REQUEST', `폴더가 없습니다: ${outDir}`);

    const emit = (patch: Partial<EditRenderProgress>): void =>
      this.deps.emit({
        renderId,
        projectId,
        mode,
        status: 'running',
        stage: '준비',
        ratio: null,
        etaSec: null,
        outputPath: null,
        previewId: null,
        error: null,
        ...patch,
      });
    emit({ stage: '준비' });

    void (async () => {
      const temp = tempOutputPath(outDir, baseName, renderId, ext);
      try {
        // 0) 원본 색 확인: HDR·10비트 원본은 사용자가 동의해야 SDR 8비트로 바꿔 내보낸다
        emit({ stage: '원본 확인' });
        const tonemapClips = new Set<number>();
        const tonemapTrackClips = new Set<string>();
        const colors: SourceColor[] = [];
        for (const [ci, c] of project.clips.entries()) {
          const col = await this.sourceColor(c.path);
          colors.push({ fileName: c.fileName, ...col });
          if (col.hdr) tonemapClips.add(ci);
        }
        for (const t of project.tracks) {
          if (!t.enabled || t.kind !== 'video') continue;
          for (const tc of t.clips) {
            if (tc.kind !== 'video') continue;
            const col = await this.sourceColor(tc.path);
            colors.push({ fileName: tc.fileName, ...col });
            if (col.hdr) tonemapTrackClips.add(tc.id);
          }
        }
        const colorWarnings = conversionWarnings(colors);
        if (colorWarnings.length > 0 && mode === 'export' && !project.output.hdrToSdr) {
          throw new AppError(
            'INVALID_REQUEST',
            `HDR·10비트 원본이 있어 결과가 SDR 8비트로 바뀝니다. 출력 설정에서 "HDR·10비트 원본을 SDR 8비트로 변환"에 동의한 뒤 다시 내보내세요.\n${colorWarnings.join('\n')}`,
          );
        }
        if (tonemapClips.size + tonemapTrackClips.size > 0 && !(await this.canTonemap())) {
          if (mode === 'export') {
            throw new AppError(
              'INVALID_REQUEST',
              '이 FFmpeg 빌드에는 톤 매핑 필터(zscale, tonemap)가 없어 HDR 원본을 SDR 로 바꿀 수 없습니다.',
            );
          }
          // 미리보기 렌더는 톤 매핑 없이 진행한다 (결과가 아니다)
          tonemapClips.clear();
          tonemapTrackClips.clear();
        }
        const plan = buildRenderPlan(project, {
          canvas,
          textDir: path.join(tempDir, 'text'),
          trfDir: path.join(tempDir, 'trf'),
          fontFile: this.deps.fontFile(),
          nullSink: process.platform === 'win32' ? 'NUL' : '/dev/null',
          tonemapClips,
          tonemapTrackClips,
        });
        for (const w of colorWarnings) plan.notes.push(w);
        for (const t of plan.textFiles) fs.writeFileSync(t.file, t.content, 'utf8');
        const tools = this.deps.tools();
        const stages = plan.stabilizePasses.length + 1;

        // 1) 손떨림 분석 패스 (클립별)
        for (const [si, pass] of plan.stabilizePasses.entries()) {
          const clip = project.clips[pass.clipIndex] as EditProject['clips'][number];
          const est = new ProgressEstimator(clip.outSec - clip.inSec, Date.now());
          emit({
            stage: `손떨림 분석 ${String(si + 1)}/${String(plan.stabilizePasses.length)}: ${clip.fileName}`,
          });
          const res = await this.deps.proc.run(
            tools.ffmpeg,
            ['-progress', 'pipe:1', '-nostats', ...pass.args],
            {
              jobId: `edit-${renderId}`,
              signal: controller.signal,
              stallTimeoutMs: RENDER_STALL_MS,
              onProgress: (s) => {
                const snap = est.update(s.outTimeSec, s.speed, Date.now(), {
                  index: si,
                  count: stages,
                });
                emit({
                  stage: `손떨림 분석 ${String(si + 1)}/${String(plan.stabilizePasses.length)}`,
                  ratio: snap.ratio,
                  etaSec: snap.etaSec,
                });
              },
            },
          );
          if (res.cancelled) throw new AppError('CANCELLED');
          if (res.exitCode !== 0 || !fs.existsSync(pass.trfFile)) {
            throw new AppError(
              'ENCODE_FAILED',
              `손떨림 분석 실패: ${res.stderrTail.slice(-3).join('\n')}`,
            );
          }
        }

        // 2) 본 렌더. 하드웨어 인코더를 고르면 먼저 쓰고, 실패하면 CPU 인코더로 다시 렌더한다.
        let hw: EditHwEncoder | null = null;
        if (mode === 'export' && project.output.hardware) {
          const st =
            this.deps
              .hardwareStatuses()
              .find((x) => x.codec === project.output.codec && x.available) ?? null;
          if (st) hw = { name: st.name, family: st.family };
          else plan.notes.push('사용할 수 있는 하드웨어 인코더가 없어 CPU 인코더로 내보냈습니다');
        }
        const argsFor = (enc: EditHwEncoder | null): string[] => [
          '-n',
          '-hide_banner',
          '-loglevel',
          'warning',
          '-nostats',
          '-progress',
          'pipe:1',
          '-nostdin',
          ...plan.inputs.flat(),
          '-filter_complex',
          plan.filterComplex,
          '-map',
          `[${plan.videoLabel}]`,
          ...(mode === 'export' && project.output.noAudio ? [] : ['-map', `[${plan.audioLabel}]`]),
          ...outputArgs(mode, project.output, enc),
          '-t',
          plan.durationSec.toFixed(3),
          temp,
        ];
        this.deps.logger.info('edit render start', {
          renderId,
          mode,
          clips: project.clips.length,
          durationSec: plan.durationSec,
          canvas,
          encoder: hw?.name ?? 'cpu',
        });
        const encodeOnce = async (enc: EditHwEncoder | null, label: string) => {
          removeAppTempFile(temp);
          const est = new ProgressEstimator(plan.durationSec, Date.now());
          emit({ stage: label });
          return this.deps.proc.run(tools.ffmpeg, argsFor(enc), {
            jobId: `edit-${renderId}`,
            signal: controller.signal,
            stallTimeoutMs: RENDER_STALL_MS,
            onProgress: (s) => {
              const snap = est.update(s.outTimeSec, s.speed, Date.now(), {
                index: stages - 1,
                count: stages,
              });
              emit({ stage: label, ratio: snap.ratio, etaSec: snap.etaSec });
            },
          });
        };
        const baseLabel = mode === 'proxy' ? '미리보기 렌더링' : '내보내기 렌더링';
        let res = await encodeOnce(hw, hw ? `${baseLabel} (${hw.name})` : baseLabel);
        if (hw && !res.cancelled && (res.exitCode !== 0 || !fs.existsSync(temp))) {
          this.deps.logger.warn('edit hardware encoder failed, falling back to CPU', {
            renderId,
            encoder: hw.name,
            tail: res.stderrTail.slice(-3),
          });
          plan.notes.push(`하드웨어 인코더(${hw.name})가 실패해 CPU 인코더로 다시 렌더했습니다`);
          res = await encodeOnce(null, `${baseLabel} (CPU 로 다시)`);
        }
        if (res.cancelled) throw new AppError('CANCELLED');
        if (res.exitCode !== 0 || !fs.existsSync(temp)) {
          throw new AppError(
            'ENCODE_FAILED',
            res.stderrTail.slice(-8).join('\n') || `코드 ${String(res.exitCode)}`,
          );
        }

        // 3) 검증: 길이·해상도·트랙
        emit({ stage: '검증', ratio: 1 });
        await this.validate(temp, plan, canvas, {
          noAudio: mode === 'export' && project.output.noAudio === true,
        });

        // 4) 확정
        const finalPath = resolveFinalPath(outDir, baseName, ext, project.clips[0]?.path ?? '');
        finalizeFile(temp, finalPath);
        const bytes = fs.statSync(finalPath).size;
        const previewId = randomUUID();
        this.deps.library.insertPreview({
          id: previewId,
          kind: mode === 'proxy' ? 'editProxy' : 'edit',
          sourceKey: `editproject:${projectId}`,
          file: finalPath,
          bytes,
          durationSec: plan.durationSec,
          settings: null,
          startSec: null,
          note:
            mode === 'proxy'
              ? `편집 미리보기 (${String(canvas.width)}×${String(canvas.height)}, 저화질). 내보내기 결과가 아닙니다.`
              : `편집 내보내기 (${String(canvas.width)}×${String(canvas.height)} ${String(canvas.fps)}fps, ${project.output.codec} CRF ${String(project.output.crf)})`,
          at: this.now(),
        });
        if (mode === 'export') {
          try {
            await this.deps.indexFile(finalPath);
          } catch (err) {
            this.deps.logger.warn('indexing edit output failed', { finalPath, err: String(err) });
          }
        }
        this.deps.logger.info('edit render done', {
          renderId,
          mode,
          finalPath,
          bytes,
          notes: plan.notes,
        });
        emit({
          status: 'done',
          stage: '완료',
          ratio: 1,
          etaSec: 0,
          outputPath: mode === 'export' ? finalPath : null,
          previewId,
        });
      } catch (err) {
        const app = AppError.from(err);
        removeAppTempFile(temp);
        if (app.code === 'CANCELLED') {
          emit({ status: 'cancelled', stage: '취소됨' });
        } else {
          this.deps.logger.warn('edit render failed', {
            renderId,
            code: app.code,
            detail: app.detail,
          });
          emit({ status: 'failed', stage: '실패', error: `${app.code}: ${app.detail ?? ''}` });
        }
      } finally {
        this.running.delete(renderId);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    })();
    return renderId;
  }

  cancel(renderId: string): boolean {
    const c = this.running.get(renderId);
    if (!c) return false;
    c.abort();
    return true;
  }

  shutdown(): void {
    for (const c of this.running.values()) c.abort();
  }

  // -------------------------------------------------------------------------

  private async validate(
    file: string,
    plan: RenderPlan,
    canvas: { width: number; height: number },
    opts: { noAudio: boolean },
  ): Promise<void> {
    const p = await this.deps.probe.probe(file);
    const v = p.streams.find((s) => s.kind === 'video');
    const a = p.streams.find((s) => s.kind === 'audio');
    if (!v) throw new AppError('VALIDATION_FAILED', '결과에 영상 트랙이 없습니다');
    if (!a && !opts.noAudio) throw new AppError('VALIDATION_FAILED', '결과에 음성 트랙이 없습니다');
    if (v.width !== canvas.width || v.height !== canvas.height) {
      throw new AppError(
        'VALIDATION_FAILED',
        `해상도 ${String(v.width)}×${String(v.height)}, 기대 ${String(canvas.width)}×${String(canvas.height)}`,
      );
    }
    const dur = p.durationSec.value;
    if (dur !== null) {
      const tol = Math.max(0.5, plan.durationSec * 0.03);
      if (Math.abs(dur - plan.durationSec) > tol) {
        throw new AppError(
          'VALIDATION_FAILED',
          `길이 ${dur.toFixed(2)}초, 기대 ${plan.durationSec.toFixed(2)}초 (허용 ${tol.toFixed(2)}초)`,
        );
      }
    }
    if (!isAppTempFile(file)) throw new AppError('UNKNOWN', '임시 파일 경로가 아닙니다');
  }

  private now(): string {
    return (this.deps.now ?? (() => new Date()))().toISOString();
  }
}

function sanitizeName(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\0]+/g, ' ').trim();
  return s.length > 0 ? s.slice(0, 80) : '편집';
}
