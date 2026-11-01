/**
 * 압축 파일 안의 이미지 보기와 폴더 이미지 목록 (킹뷰: 압축 파일 내부 탐색).
 * 항목은 앱 캐시에 해시 이름으로 풀고, 미디어 토큰으로만 노출한다. 원본 압축 파일은 읽기만 한다.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../AppError';
import type { MediaTokenRegistry } from '../library/MediaTokenRegistry';
import type { Logger } from '../../platform/logger';
import {
  isImageEntryName,
  mimeOfImageName,
  naturalCompare,
  readZipEntries,
  readZipEntry,
  type ZipEntry,
} from './ZipReader';

const MAX_ARCHIVE_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_FOLDER_IMAGES = 5000;
const IMAGE_FILE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.tif', '.tiff'];

export interface ArchiveDeps {
  tokens: MediaTokenRegistry;
  cacheDir: string;
  logger: Logger;
}

export class ArchiveService {
  constructor(private readonly deps: ArchiveDeps) {
    fs.mkdirSync(deps.cacheDir, { recursive: true });
  }

  private readZip(zipPath: string): { buf: Buffer; entries: ZipEntry[] } {
    const ext = path.extname(zipPath).toLowerCase();
    if (ext !== '.zip' && ext !== '.cbz')
      throw new AppError('UNSUPPORTED_INPUT', 'ZIP 과 CBZ 만 열 수 있습니다');
    let st: fs.Stats;
    try {
      st = fs.statSync(zipPath);
    } catch (err) {
      throw new AppError('INPUT_MISSING', zipPath, { cause: err });
    }
    if (!st.isFile()) throw new AppError('INPUT_UNREADABLE', zipPath);
    if (st.size > MAX_ARCHIVE_FILE_BYTES)
      throw new AppError('UNSUPPORTED_INPUT', '파일이 1 GiB 를 넘어 열 수 없습니다');
    const buf = fs.readFileSync(zipPath);
    try {
      return { buf, entries: readZipEntries(buf) };
    } catch (err) {
      throw new AppError('UNSUPPORTED_INPUT', err instanceof Error ? err.message : String(err), {
        cause: err,
      });
    }
  }

  /** 압축 파일 안의 이미지 항목을 자연 정렬 순서로 돌려준다. 암호가 걸린 항목은 열 수 없으므로 목록에서 뺀다. */
  list(zipPath: string): { name: string; size: number }[] {
    const { entries } = this.readZip(zipPath);
    return entries
      .filter((e) => isImageEntryName(e.name) && (e.flags & 0x1) === 0)
      .map((e) => ({ name: e.name, size: e.size }))
      .sort((a, b) => naturalCompare(a.name, b.name));
  }

  /** 항목 하나를 캐시에 풀고 토큰 URL 을 돌려준다 */
  open(zipPath: string, name: string): { url: string; mime: string } {
    const { buf, entries } = this.readZip(zipPath);
    const entry = entries.find((e) => e.name === name && isImageEntryName(e.name));
    if (!entry) throw new AppError('MEDIA_NOT_FOUND', `압축 안에 없는 항목: ${name}`);
    let data: Buffer;
    try {
      data = readZipEntry(buf, entry);
    } catch (err) {
      throw new AppError('UNSUPPORTED_INPUT', err instanceof Error ? err.message : String(err), {
        cause: err,
      });
    }
    const st = fs.statSync(zipPath);
    const key = createHash('sha1')
      .update(`${zipPath}|${String(st.size)}|${String(Math.floor(st.mtimeMs))}|${name}`)
      .digest('hex');
    const ext = path.extname(name).toLowerCase() || '.img';
    const file = path.join(this.deps.cacheDir, `${key}${ext}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, data);
    const mime = mimeOfImageName(name);
    return { url: this.deps.tokens.issue(`archive:${key}`, file, mime), mime };
  }

  /** 폴더 안의 이미지 파일 경로 (직계 파일만, 자연 정렬) */
  folderImages(dir: string): string[] {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      throw new AppError('INPUT_UNREADABLE', dir, { cause: err });
    }
    const files = names
      .filter((n) => !n.startsWith('.') && IMAGE_FILE_EXT.includes(path.extname(n).toLowerCase()))
      .map((n) => path.join(dir, n))
      .filter((p) => {
        try {
          return fs.lstatSync(p).isFile();
        } catch {
          return false;
        }
      })
      .sort((a, b) => naturalCompare(path.basename(a), path.basename(b)));
    if (files.length > MAX_FOLDER_IMAGES)
      this.deps.logger.warn('folder images truncated', { dir, count: files.length });
    return files.slice(0, MAX_FOLDER_IMAGES);
  }
}
