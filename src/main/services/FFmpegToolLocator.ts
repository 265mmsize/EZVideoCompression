/**
 * ffmpeg / ffprobe 실행 파일 탐지.
 *
 * 탐색 순서: 사용자 지정 경로 → 번들 경로(resources/binaries/<platform>-<arch>) → PATH.
 * 각 후보는 실제로 `-version` 을 실행해 확인한다. 파일이 있다는 것만으로는 신뢰하지 않는다.
 * 또한 앱이 사용하는 옵션(-progress, -fps_mode)을 지원하는 최소 버전을 검사한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ToolInfo, ToolStatus } from '../../shared/types/domain';
import type { FFmpegProcessService } from './FFmpegProcessService';

export interface LocatorOptions {
  overrideFfmpeg: string | null;
  overrideFfprobe: string | null;
  /** 번들 바이너리 디렉터리 (예: <resources>/binaries/win32-x64) */
  bundledDir: string | null;
  /** 실행 파일 확장자 (Windows: .exe) */
  exeSuffix: string;
  pathEnv: string | undefined;
}

/** -fps_mode 는 FFmpeg 5.1 에서 도입되었다. */
const MIN_MAJOR = 5;
const MIN_MINOR_WHEN_MAJOR_5 = 1;

export function parseFfmpegVersion(
  text: string,
): { major: number; minor: number; raw: string } | null {
  // 예: "ffmpeg version 6.1.1-3ubuntu5 ..." / "ffmpeg version n7.0-..." / "ffprobe version 7.1 ..."
  const m = /version\s+n?(\d+)\.(\d+)/.exec(text);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const firstLine = text.split(/\r?\n/)[0] ?? text;
  return { major, minor, raw: firstLine.trim() };
}

export function isSupportedVersion(v: { major: number; minor: number }): boolean {
  if (v.major > MIN_MAJOR) return true;
  return v.major === MIN_MAJOR && v.minor >= MIN_MINOR_WHEN_MAJOR_5;
}

/** 탐색 후보 목록을 만든다 (순수 함수: 테스트 가능) */
export function buildCandidates(
  name: 'ffmpeg' | 'ffprobe',
  opts: LocatorOptions,
): { path: string; source: ToolInfo['source'] }[] {
  const out: { path: string; source: ToolInfo['source'] }[] = [];
  const override = name === 'ffmpeg' ? opts.overrideFfmpeg : opts.overrideFfprobe;
  if (override) out.push({ path: override, source: 'override' });
  if (opts.bundledDir) {
    out.push({ path: path.join(opts.bundledDir, name + opts.exeSuffix), source: 'bundled' });
  }
  out.push({ path: name + opts.exeSuffix, source: 'path' });
  return out;
}

export class FFmpegToolLocator {
  constructor(private readonly proc: FFmpegProcessService) {}

  async locate(opts: LocatorOptions): Promise<ToolStatus> {
    const ffmpeg = await this.probeTool('ffmpeg', opts);
    const ffprobe = await this.probeTool('ffprobe', opts);
    const encoders = ffmpeg.path ? await this.listSoftwareEncoders(ffmpeg.path) : [];
    return {
      ffmpeg,
      ffprobe,
      ready:
        ffmpeg.path !== null &&
        ffprobe.path !== null &&
        ffmpeg.error === null &&
        ffprobe.error === null,
      encoders,
      // 하드웨어 인코더 검사는 HardwareEncoderService 가 맡고, 컨테이너가 결과를 채운다
      hardwareEncoders: [],
    };
  }

  private async probeTool(name: 'ffmpeg' | 'ffprobe', opts: LocatorOptions): Promise<ToolInfo> {
    const candidates = buildCandidates(name, opts);
    let lastError: string | null = null;
    for (const c of candidates) {
      // 절대 경로 후보는 파일 존재를 먼저 확인한다. PATH 후보는 실행 결과로 판단한다.
      if (path.isAbsolute(c.path) && !fs.existsSync(c.path)) {
        lastError = `${c.path} 파일이 없습니다`;
        continue;
      }
      try {
        // ffmpeg -version 은 stdout 으로 출력하므로 캡처한다
        const res = await this.proc.run(c.path, ['-hide_banner', '-version'], {
          timeoutMs: 15_000,
          captureStdout: true,
        });
        if (res.exitCode !== 0) {
          lastError = `${c.path} 실행 실패 (코드 ${String(res.exitCode)})`;
          continue;
        }
        const ver = parseFfmpegVersion(res.stdout || res.stderrTail.join('\n'));
        if (!ver) {
          lastError = `${c.path} 버전 정보를 읽을 수 없습니다`;
          continue;
        }
        if (!isSupportedVersion(ver)) {
          return {
            name,
            path: c.path,
            source: c.source,
            version: ver.raw,
            error: `FFmpeg ${String(ver.major)}.${String(ver.minor)} 은 지원 범위(5.1 이상)가 아닙니다`,
          };
        }
        return { name, path: c.path, source: c.source, version: ver.raw, error: null };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      name,
      path: null,
      source: 'missing',
      version: null,
      error: lastError ?? '찾을 수 없음',
    };
  }

  /** 소프트웨어 인코더 가용성만 확인한다. 하드웨어 인코더는 4단계에서 실제 테스트 인코딩으로 검사한다. */
  private async listSoftwareEncoders(ffmpegPath: string): Promise<string[]> {
    const wanted = ['libx264', 'libx265', 'libwebp'];
    const res = await this.proc.run(ffmpegPath, ['-hide_banner', '-encoders'], {
      timeoutMs: 15_000,
      captureStdout: true,
    });
    return wanted.filter((w) => new RegExp(`\\b${w}\\b`).test(res.stdout));
  }
}
