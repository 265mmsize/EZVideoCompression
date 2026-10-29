/**
 * 서비스 조립 루트 (Electron 비의존).
 *
 * Electron 의 app 경로 등 플랫폼 값은 호출자가 넘긴다. 그래서 통합 테스트도 같은 조립 코드를 쓴다.
 */
import path from 'node:path';
import type { ToolStatus } from '../shared/types/domain';
import { openDatabase, type Db } from './database/Database';
import { JobRepository } from './repositories/JobRepository';
import { SettingsRepository } from './repositories/SettingsRepository';
import { Logger } from './platform/logger';
import { AppError } from './services/AppError';
import { ExternalSubtitleService } from './services/ExternalSubtitleService';
import { FFmpegProcessService } from './services/FFmpegProcessService';
import { FFmpegToolLocator, type LocatorOptions } from './services/FFmpegToolLocator';
import { MediaProbeService } from './services/MediaProbeService';
import { OutputValidationService } from './services/OutputValidationService';
import { JobRunner, type ToolPaths } from './services/JobRunner';
import { SampleEncodeService } from './services/SampleEncodeService';
import { HardwareEncoderService } from './services/HardwareEncoderService';
import { JobQueueService } from './services/JobQueueService';
import { LibraryRepository } from './repositories/LibraryRepository';
import { LibraryIndexer } from './services/library/LibraryIndexer';
import { LibraryService } from './services/library/LibraryService';
import { MediaTokenRegistry } from './services/library/MediaTokenRegistry';
import { PreviewService } from './services/library/PreviewService';
import { ThumbnailService } from './services/library/ThumbnailService';
import { ImageEditService } from './services/image/ImageEditService';
import { EditProjectRepository } from './repositories/EditProjectRepository';
import { VideoEditService, findDefaultFont } from './services/edit/VideoEditService';
import type { EventChannel } from '../shared/contracts/ipc';

export interface ContainerOptions {
  /** 사용자 데이터 디렉터리 (DB, 로그, 임시 파일) */
  userDataDir: string;
  /** 번들 바이너리 디렉터리. 없으면 null */
  bundledBinDir: string | null;
  /** 실행 파일 확장자 (Windows: .exe) */
  exeSuffix: string;
  /** 이벤트 전송 함수 (Electron 에서는 webContents.send) */
  emit: (channel: EventChannel, payload: unknown) => void;
  /** 로그 콘솔 출력 여부 */
  echoLogs?: boolean;
}

export interface AppServices {
  db: Db;
  logger: Logger;
  settings: SettingsRepository;
  jobs: JobRepository;
  proc: FFmpegProcessService;
  locator: FFmpegToolLocator;
  probe: MediaProbeService;
  runner: JobRunner;
  queue: JobQueueService;
  library: LibraryService;
  indexer: LibraryIndexer;
  previews: PreviewService;
  imageEdit: ImageEditService;
  videoEdit: VideoEditService;
  tokens: MediaTokenRegistry;
  /** 마지막 탐지 결과 */
  toolStatus: () => ToolStatus | null;
  /** 도구를 다시 탐지하고 결과를 캐시한다 */
  refreshTools: () => Promise<ToolStatus>;
  /** 사용 가능한 도구 경로. 준비되지 않았으면 TOOL_NOT_FOUND */
  tools: () => ToolPaths;
  tempRoot: string;
  logsDir: string;
  close: () => Promise<void>;
}

export function createServices(opts: ContainerOptions): AppServices {
  const logsDir = path.join(opts.userDataDir, 'logs');
  const tempRoot = path.join(opts.userDataDir, 'tmp');
  const logger = new Logger(logsDir, { echoToConsole: opts.echoLogs ?? false });
  const db = openDatabase(path.join(opts.userDataDir, 'videoslim.sqlite'));
  const settings = new SettingsRepository(db);
  const jobs = new JobRepository(db);
  const proc = new FFmpegProcessService(logger);
  const locator = new FFmpegToolLocator(proc);
  const probe = new MediaProbeService(proc, () => requireTools().ffprobe);
  const validator = new OutputValidationService(probe, proc);

  let status: ToolStatus | null = null;
  /** 진행 중인 탐지. 탐지가 끝나기 전에 들어온 작업은 이 약속을 기다린다. */
  let refreshing: Promise<ToolStatus> | null = null;
  const locatorOptions = (): LocatorOptions => {
    const s = settings.get();
    return {
      overrideFfmpeg: s.ffmpegPath,
      overrideFfprobe: s.ffprobePath,
      bundledDir: opts.bundledBinDir,
      exeSuffix: opts.exeSuffix,
      pathEnv: process.env['PATH'],
    };
  };
  const requireTools = (): ToolPaths => {
    if (!status || !status.ready || !status.ffmpeg.path || !status.ffprobe.path) {
      throw new AppError('TOOL_NOT_FOUND', status?.ffmpeg.error ?? status?.ffprobe.error ?? null);
    }
    return {
      ffmpeg: status.ffmpeg.path,
      ffprobe: status.ffprobe.path,
      version: status.ffmpeg.version ?? 'unknown',
    };
  };

  const subtitles = new ExternalSubtitleService(proc, () => requireTools().ffprobe);
  const runner = new JobRunner(proc, probe, validator, logger, requireTools, subtitles);
  const sampler = new SampleEncodeService(proc);
  const hardware = new HardwareEncoderService(proc);
  const queue = new JobQueueService({
    jobs,
    settings,
    runner,
    sampler,
    logger,
    tempRoot,
    tools: requireTools,
    toolsReady: async () => {
      if (refreshing) await refreshing.catch(() => undefined);
    },
    hardwareStatuses: () => status?.hardwareEncoders ?? [],
    emit: opts.emit,
  });

  // ----- 미디어 라이브러리 -----
  const toolsReady = async (): Promise<void> => {
    if (refreshing) await refreshing.catch(() => undefined);
  };
  const libraryRepo = new LibraryRepository(db);
  const tokens = new MediaTokenRegistry();
  const limitBytes = (): number => settings.get().cacheLimitMiB * 1024 * 1024;
  const thumbs = new ThumbnailService({
    repo: libraryRepo,
    proc,
    tools: requireTools,
    dir: path.join(opts.userDataDir, 'thumbs'),
    logger,
    limitBytes,
    // 인코딩 중에는 썸네일 생성을 1개로 제한해 인코딩을 방해하지 않는다
    concurrency: () => (queue.queueState().runningJobId ? 1 : 2),
  });
  const indexer = new LibraryIndexer({
    repo: libraryRepo,
    probe,
    logger,
    emit: (state) => opts.emit('library:indexing', state),
    toolsReady,
  });
  const previews = new PreviewService({
    repo: libraryRepo,
    jobs,
    probe,
    proc,
    tools: requireTools,
    thumbs,
    tokens,
    dir: path.join(opts.userDataDir, 'previews'),
    tempRoot,
    logger,
    emit: (p) => opts.emit('library:preview.progress', p),
  });
  const library = new LibraryService({
    repo: libraryRepo,
    indexer,
    queue,
    thumbs,
    previews,
    tokens,
    logger,
    limitBytes,
  });
  const videoEdit = new VideoEditService({
    repo: new EditProjectRepository(db),
    library: libraryRepo,
    probe,
    proc,
    tools: requireTools,
    thumbs,
    tokens,
    previewDir: path.join(opts.userDataDir, 'previews'),
    tempRoot,
    logger,
    emit: (p) => opts.emit('edit:render.progress', p),
    indexFile: (p) => library.indexFile(p),
    fontFile: () => findDefaultFont(),
  });
  const imageEdit = new ImageEditService({
    proc,
    probe,
    tools: requireTools,
    tokens,
    thumbs,
    previewDir: path.join(opts.userDataDir, 'edit-previews'),
    logger,
    indexFile: (p) => library.indexFile(p),
  });

  return {
    db,
    logger,
    settings,
    jobs,
    proc,
    locator,
    probe,
    runner,
    queue,
    library,
    indexer,
    previews,
    imageEdit,
    videoEdit,
    tokens,
    toolStatus: () => status,
    refreshTools: () => {
      const run = async (): Promise<ToolStatus> => {
        const located = await locator.locate(locatorOptions());
        // 소프트웨어 도구가 확인되면 즉시 사용 가능하게 하고, 하드웨어 검사(테스트 인코딩)는 그 뒤에 이어서 한다
        status = { ...located, hardwareEncoders: [] };
        logger.info('tools located', {
          ffmpeg: status.ffmpeg.path,
          ffprobe: status.ffprobe.path,
          ready: status.ready,
          encoders: status.encoders,
        });
        opts.emit('tools:changed', status);
        if (located.ffmpeg.path) {
          const hardwareEncoders = await hardware.probeAll(located.ffmpeg.path);
          status = { ...located, hardwareEncoders };
          logger.info('hardware encoders probed', {
            available: hardwareEncoders.filter((h) => h.available).map((h) => h.name),
          });
          opts.emit('tools:changed', status);
        }
        return status;
      };
      refreshing = run().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },
    tools: requireTools,
    tempRoot,
    logsDir,
    close: async () => {
      indexer.cancel();
      videoEdit.shutdown();
      previews.shutdown();
      await queue.shutdown();
      await indexer.idle();
      await proc.terminateAll();
      db.close();
    },
  };
}
