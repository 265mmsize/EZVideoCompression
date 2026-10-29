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
import fs from 'node:fs';
import path from 'node:path';
import type {
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
import type { MediaTokenRegistry } from '../library/MediaTokenRegistry';
import type { ThumbnailService } from '../library/ThumbnailService';
import {
  buildRenderPlan,
  clipDurationSec,
  outputArgs,
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
    createdAt: at,
    updatedAt: at,
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
    const next = { ...project, updatedAt: this.now() };
    if (!this.deps.repo.update(next))
      throw new AppError('INVALID_REQUEST', '프로젝트를 찾을 수 없습니다');
    return next;
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
      width: v?.width ?? null,
      height: v?.height ?? null,
      hasAudio: a !== null,
      hasVideo: v !== null,
    };
  }

  /** 원본 파일의 시점 프레임 (효과 미적용). 썸네일 캐시를 쓴다 */
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

  render(projectId: string, mode: EditRenderMode, target: ImageExportTarget | null): string {
    const project = this.get(projectId);
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
        const plan = buildRenderPlan(project, {
          canvas,
          textDir: path.join(tempDir, 'text'),
          trfDir: path.join(tempDir, 'trf'),
          fontFile: this.deps.fontFile(),
          nullSink: process.platform === 'win32' ? 'NUL' : '/dev/null',
        });
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

        // 2) 본 렌더
        removeAppTempFile(temp);
        const args = [
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
          '-map',
          `[${plan.audioLabel}]`,
          ...outputArgs(mode, project.output),
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
        });
        const est = new ProgressEstimator(plan.durationSec, Date.now());
        emit({ stage: mode === 'proxy' ? '미리보기 렌더링' : '내보내기 렌더링' });
        const res = await this.deps.proc.run(tools.ffmpeg, args, {
          jobId: `edit-${renderId}`,
          signal: controller.signal,
          stallTimeoutMs: RENDER_STALL_MS,
          onProgress: (s) => {
            const snap = est.update(s.outTimeSec, s.speed, Date.now(), {
              index: stages - 1,
              count: stages,
            });
            emit({
              stage: mode === 'proxy' ? '미리보기 렌더링' : '내보내기 렌더링',
              ratio: snap.ratio,
              etaSec: snap.etaSec,
            });
          },
        });
        if (res.cancelled) throw new AppError('CANCELLED');
        if (res.exitCode !== 0 || !fs.existsSync(temp)) {
          throw new AppError(
            'ENCODE_FAILED',
            res.stderrTail.slice(-8).join('\n') || `코드 ${String(res.exitCode)}`,
          );
        }

        // 3) 검증: 길이·해상도·트랙
        emit({ stage: '검증', ratio: 1 });
        await this.validate(temp, plan, canvas);

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
  ): Promise<void> {
    const p = await this.deps.probe.probe(file);
    const v = p.streams.find((s) => s.kind === 'video');
    const a = p.streams.find((s) => s.kind === 'audio');
    if (!v) throw new AppError('VALIDATION_FAILED', '결과에 영상 트랙이 없습니다');
    if (!a) throw new AppError('VALIDATION_FAILED', '결과에 음성 트랙이 없습니다');
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
