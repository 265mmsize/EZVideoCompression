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
import { FFmpegProcessService } from './services/FFmpegProcessService';
import { FFmpegToolLocator, type LocatorOptions } from './services/FFmpegToolLocator';
import { MediaProbeService } from './services/MediaProbeService';
import { OutputValidationService } from './services/OutputValidationService';
import { JobRunner, type ToolPaths } from './services/JobRunner';
import { SampleEncodeService } from './services/SampleEncodeService';
import { HardwareEncoderService } from './services/HardwareEncoderService';
import { JobQueueService } from './services/JobQueueService';
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

  const runner = new JobRunner(proc, probe, validator, logger, requireTools);
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
    hardwareStatuses: () => status?.hardwareEncoders ?? [],
    emit: opts.emit,
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
    toolStatus: () => status,
    refreshTools: async () => {
      const located = await locator.locate(locatorOptions());
      // 하드웨어 검사는 도구가 준비된 경우에만 수행한다 (테스트 인코딩은 실제 ffmpeg 를 실행한다)
      const hardwareEncoders = located.ffmpeg.path
        ? await hardware.probeAll(located.ffmpeg.path)
        : [];
      status = { ...located, hardwareEncoders };
      logger.info('tools located', {
        ffmpeg: status.ffmpeg.path,
        ffprobe: status.ffprobe.path,
        ready: status.ready,
        encoders: status.encoders,
      });
      opts.emit('tools:changed', status);
      return status;
    },
    tools: requireTools,
    tempRoot,
    logsDir,
    close: async () => {
      await queue.shutdown();
      await proc.terminateAll();
      db.close();
    },
  };
}
