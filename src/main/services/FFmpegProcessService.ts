/**
 * FFmpeg / ffprobe 프로세스 실행 서비스.
 *
 * 설계 이유:
 * - shell 을 사용하지 않고 인자를 배열로 넘긴다. 한글·공백·특수문자 경로가 그대로 전달되고,
 *   문자열 연결로 셸 명령을 만들 때 생기는 인자 주입을 원천 차단한다.
 * - 실행 파일 경로는 앱이 관리하는 값(CapabilityService 가 결정)만 사용한다.
 * - 취소는 "정상 종료 요청 → 유예 시간 → 강제 종료" 순서로 진행하고, 종료 후 잔여 프로세스를 확인한다.
 * - stderr 는 링 버퍼로 보관한다. 실패 시 마지막 출력이 원인 파악에 가장 유용하다.
 * - -progress pipe:1 의 기계 판독용 출력을 파싱해 진행률 콜백으로 전달한다.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../platform/logger';
import { AppError } from './AppError';

export interface ProgressSample {
  /** 현재까지 출력된 미디어 시간 (초) */
  outTimeSec: number | null;
  /** 실시간 대비 속도 (1.0 = 실시간) */
  speed: number | null;
  frame: number | null;
  fps: number | null;
  totalSizeBytes: number | null;
  bitrateKbps: number | null;
}

export interface RunOptions {
  /** 분석·검증처럼 짧아야 하는 호출에 적용하는 전체 타임아웃 (ms) */
  timeoutMs?: number;
  /** 진행 정보가 이 시간(ms) 동안 갱신되지 않으면 멈춤으로 판단한다 (인코딩 전용) */
  stallTimeoutMs?: number;
  onProgress?: (sample: ProgressSample) => void;
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
  jobId?: string;
  /** stdout 을 통째로 수집해 반환할지 여부 (ffprobe JSON 용). progress 와 함께 쓰지 않는다. */
  captureStdout?: boolean;
  /** 환경 변수 추가 (예: AV_LOG_FORCE_NOCOLOR) */
  env?: Record<string, string>;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  /** 마지막 stderr 줄들 (최대 STDERR_KEEP_LINES) */
  stderrTail: string[];
  timedOut: boolean;
  stalled: boolean;
  cancelled: boolean;
  durationMs: number;
}

const STDERR_KEEP_LINES = 200;
const GRACEFUL_EXIT_WAIT_MS = 3000;

export class FFmpegProcessService {
  private readonly live = new Set<ChildProcess>();

  constructor(private readonly logger: Logger) {}

  /** 실행 중인 자식 프로세스 수 (테스트와 종료 시 잔여 프로세스 확인용) */
  get liveCount(): number {
    return this.live.size;
  }

  /**
   * 프로세스를 실행하고 종료까지 기다린다.
   * 비정상 종료라도 예외를 던지지 않고 RunResult 로 돌려준다. 호출자가 맥락에 맞는 오류 코드를 정한다.
   */
  run(executable: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      const startedAt = Date.now();
      const stderrTail: string[] = [];
      let stdout = '';
      let timedOut = false;
      let stalled = false;
      let cancelled = false;
      let settled = false;

      let child: ChildProcess;
      try {
        child = spawn(executable, args, {
          // shell: false 가 기본이지만 의도를 명시한다.
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, AV_LOG_FORCE_NOCOLOR: '1', ...options.env },
        });
      } catch (err) {
        reject(new AppError('TOOL_NOT_FOUND', `${executable}: ${String(err)}`, { cause: err }));
        return;
      }
      this.live.add(child);
      this.logger.debug('spawn', {
        jobId: options.jobId,
        pid: child.pid,
        executable,
        args: args.map(redactLongArg),
      });

      // ----- stdout: progress 또는 전체 캡처 -----
      let stdoutBuf = '';
      let progressBlock: Record<string, string> = {};
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (options.captureStdout) {
          stdout += chunk;
          return;
        }
        if (!options.onProgress) return;
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          const eq = line.indexOf('=');
          if (eq < 0) continue;
          const key = line.slice(0, eq);
          const value = line.slice(eq + 1);
          progressBlock[key] = value;
          // -progress 출력은 "progress=continue|end" 줄로 한 블록이 끝난다.
          if (key === 'progress') {
            options.onProgress(parseProgressBlock(progressBlock));
            progressBlock = {};
            touchStall();
          }
        }
      });

      // ----- stderr: 링 버퍼 -----
      let stderrBuf = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderrBuf += chunk;
        // ffmpeg 는 진행 표시에 \r 을 쓰므로 둘 다 줄 구분자로 본다.
        const parts = stderrBuf.split(/\r\n|\r|\n/);
        stderrBuf = parts.pop() ?? '';
        for (const p of parts) {
          if (!p.trim()) continue;
          stderrTail.push(p);
          if (stderrTail.length > STDERR_KEEP_LINES) stderrTail.shift();
          options.onStderrLine?.(p);
        }
      });

      // ----- 타임아웃 / 멈춤 감지 / 취소 -----
      let hardTimer: NodeJS.Timeout | null = null;
      let stallTimer: NodeJS.Timeout | null = null;
      const touchStall = (): void => {
        if (!options.stallTimeoutMs) return;
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          stalled = true;
          this.logger.warn('process stalled, terminating', {
            jobId: options.jobId,
            pid: child.pid,
          });
          void this.terminate(child);
        }, options.stallTimeoutMs);
      };
      if (options.timeoutMs) {
        hardTimer = setTimeout(() => {
          timedOut = true;
          this.logger.warn('process timed out, terminating', {
            jobId: options.jobId,
            pid: child.pid,
          });
          void this.terminate(child);
        }, options.timeoutMs);
      }
      touchStall();

      const onAbort = (): void => {
        cancelled = true;
        this.logger.info('process cancel requested', { jobId: options.jobId, pid: child.pid });
        void this.terminate(child);
      };
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      }

      const cleanup = (): void => {
        if (hardTimer) clearTimeout(hardTimer);
        if (stallTimer) clearTimeout(stallTimer);
        options.signal?.removeEventListener('abort', onAbort);
        this.live.delete(child);
      };

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES') {
          reject(new AppError('TOOL_NOT_FOUND', `${executable}: ${err.message}`, { cause: err }));
        } else {
          reject(new AppError('ENCODE_FAILED', `프로세스 오류: ${err.message}`, { cause: err }));
        }
      });

      child.on('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (stderrBuf.trim()) stderrTail.push(stderrBuf);
        this.logger.debug('process closed', {
          jobId: options.jobId,
          pid: child.pid,
          exitCode,
          signal,
          timedOut,
          stalled,
          cancelled,
        });
        resolve({
          exitCode,
          signal,
          stdout,
          stderrTail,
          timedOut,
          stalled,
          cancelled,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  /**
   * 정상 종료를 시도한 뒤 유예 시간 안에 끝나지 않으면 강제 종료한다.
   * Windows 에서는 SIGTERM 이 곧바로 강제 종료로 동작하므로 결과는 같다.
   */
  async terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    const exited = await waitForExit(child, GRACEFUL_EXIT_WAIT_MS);
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {
        // 이미 종료된 경우
      }
      await waitForExit(child, 2000);
    }
  }

  /** 앱 종료 시 남아 있는 프로세스를 모두 정리한다. */
  async terminateAll(): Promise<void> {
    await Promise.all([...this.live].map((c) => this.terminate(c)));
  }
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const t = setTimeout(() => resolve(false), ms);
    child.once('close', () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

/** -progress 블록을 숫자형 샘플로 변환한다. "N/A" 는 null 로 둔다. */
export function parseProgressBlock(block: Record<string, string>): ProgressSample {
  const num = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    const t = v.trim();
    if (!t || t === 'N/A') return null;
    const n = Number.parseFloat(t.replace(/[^0-9.+-eE]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  // out_time_us 가 가장 정확하다. 없으면 out_time_ms (실제로는 마이크로초) 또는 out_time(HH:MM:SS.micro) 을 사용한다.
  let outTimeSec: number | null = null;
  const us = num(block['out_time_us']);
  if (us !== null && us >= 0) outTimeSec = us / 1_000_000;
  else {
    const ms = num(block['out_time_ms']);
    if (ms !== null && ms >= 0) outTimeSec = ms / 1_000_000;
    else if (block['out_time']) outTimeSec = parseClock(block['out_time']);
  }
  const speedRaw = block['speed'];
  const speed = speedRaw ? num(speedRaw.replace('x', '')) : null;
  return {
    outTimeSec,
    speed: speed !== null && speed > 0 ? speed : null,
    frame: num(block['frame']),
    fps: num(block['fps']),
    totalSizeBytes: num(block['total_size']),
    bitrateKbps: block['bitrate'] ? num(block['bitrate'].replace('kbits/s', '')) : null,
  };
}

export function parseClock(text: string): number | null {
  const m = /^(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const sec = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return Number.isFinite(sec) ? sign * sec : null;
}

function redactLongArg(a: string): string {
  return a.length > 300 ? `${a.slice(0, 300)}…` : a;
}
