/**
 * 출력 파일 경로 결정, 임시 파일 관리, 결과 확정.
 *
 * 원본 보호 규칙
 * - 원본 파일에는 어떤 쓰기도 하지 않는다. 출력은 항상 새 파일이다.
 * - 출력 경로가 원본과 같으면 거부한다 (대소문자 무시 비교 포함).
 * - 확정은 같은 볼륨 안에서 수행한다. 우선 hard link 로 "이미 있으면 실패"를 원자적으로 보장하고,
 *   링크를 지원하지 않는 파일시스템(exFAT 등)에서만 존재 검사 후 rename 으로 대체한다.
 * - 정리는 앱이 만든 임시 파일(파일명에 TEMP_MARKER 포함)만 대상으로 한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './AppError';

export const TEMP_MARKER = '.vslim-tmp-';
const MAX_NAME_SUFFIX = 999;
/** 디스크 여유 공간 검사에 더하는 안전 여유분 (256 MiB) */
export const DISK_SAFETY_BYTES = 256 * 1024 * 1024;

export function normalizeForCompare(
  p: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isSamePath(a: string, b: string, platform?: NodeJS.Platform): boolean {
  return normalizeForCompare(a, platform) === normalizeForCompare(b, platform);
}

/** 작업 ID 앞 8자리를 임시 파일 식별자로 쓴다. 충돌을 피하려고 기존 파일 존재 여부도 확인한다. */
export function tempOutputPath(
  outDir: string,
  baseName: string,
  jobId: string,
  ext: string,
): string {
  const tag = jobId.replace(/-/g, '').slice(0, 8);
  return path.join(outDir, `.${baseName}${TEMP_MARKER}${tag}.${ext}`);
}

/**
 * 확정 파일 이름을 고른다. 이미 존재하면 " (2)", " (3)" … 을 붙인다.
 * 원본 경로와 같은 이름이면 다음 번호로 넘어간다.
 */
export function resolveFinalPath(
  outDir: string,
  baseName: string,
  ext: string,
  inputPath: string,
  reserved: ReadonlySet<string> = new Set(),
): string {
  for (let n = 1; n <= MAX_NAME_SUFFIX; n++) {
    const name = n === 1 ? `${baseName}.${ext}` : `${baseName} (${String(n)}).${ext}`;
    const candidate = path.join(outDir, name);
    if (isSamePath(candidate, inputPath)) continue;
    if (reserved.has(normalizeForCompare(candidate))) continue;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new AppError('OUTPUT_PATH_CONFLICT', `${outDir} 에 사용 가능한 파일 이름이 없습니다`);
}

export function isAppTempFile(p: string): boolean {
  return path.basename(p).includes(TEMP_MARKER);
}

/** 볼륨의 사용 가능한 바이트 수. 조회할 수 없으면 null. */
export function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export function assertDiskSpace(dir: string, neededBytes: number): void {
  const free = freeBytes(dir);
  if (free === null) return; // 조회 불가 환경에서는 막지 않고 인코더 오류에 맡긴다
  if (free < neededBytes + DISK_SAFETY_BYTES) {
    throw new AppError(
      'DISK_SPACE_LOW',
      `필요 약 ${fmtMiB(neededBytes + DISK_SAFETY_BYTES)}, 여유 ${fmtMiB(free)}`,
    );
  }
}

function fmtMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MiB`;
}

/**
 * 임시 파일을 최종 경로로 옮긴다. 대상이 이미 있으면 실패한다 (덮어쓰기 금지).
 */
export function finalizeFile(tempPath: string, finalPath: string): void {
  try {
    // link 는 대상이 있으면 EEXIST 로 실패한다. 원자적이며 덮어쓰지 않는다.
    fs.linkSync(tempPath, finalPath);
    fs.unlinkSync(tempPath);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new AppError(
        'OUTPUT_PATH_CONFLICT',
        `이미 존재하는 파일: ${path.basename(finalPath)}`,
        { cause: err },
      );
    }
    // 링크 미지원 파일시스템만 아래 대체 경로를 쓴다.
    if (
      code !== 'EPERM' &&
      code !== 'ENOTSUP' &&
      code !== 'EXDEV' &&
      code !== 'EOPNOTSUPP' &&
      code !== 'ENOSYS'
    ) {
      throw err;
    }
  }
  if (fs.existsSync(finalPath)) {
    throw new AppError('OUTPUT_PATH_CONFLICT', `이미 존재하는 파일: ${path.basename(finalPath)}`);
  }
  fs.renameSync(tempPath, finalPath);
}

/** 앱이 만든 임시 파일만 삭제한다. 그 밖의 경로는 건드리지 않는다. */
export function removeAppTempFile(p: string | null): void {
  if (!p) return;
  if (!isAppTempFile(p)) return;
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // 삭제 실패는 다음 기동 때 복구 루틴이 다시 시도한다.
  }
}

/** 입력 파일이 분석 이후 바뀌었는지 확인한다. */
export function assertInputUnchanged(
  inputPath: string,
  expected: { sizeBytes: number; mtimeMs: number },
): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(inputPath);
  } catch (err) {
    throw new AppError('INPUT_MISSING', inputPath, { cause: err });
  }
  if (st.size !== expected.sizeBytes || Math.floor(st.mtimeMs) !== Math.floor(expected.mtimeMs)) {
    throw new AppError('INPUT_CHANGED', `크기 ${String(expected.sizeBytes)} → ${String(st.size)}`);
  }
}
