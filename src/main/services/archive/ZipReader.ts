/**
 * ZIP(CBZ 포함) 읽기: 중앙 디렉터리를 읽고, 저장(0)과 DEFLATE(8) 항목만 풀어 준다. 외부 라이브러리를 쓰지 않는다.
 * 암호 항목, ZIP64, 그 밖의 압축 방식은 지원하지 않으며 사유와 함께 거부한다.
 * 항목 이름은 경로로 쓰지 않는다 (경로 탈출 방지). 꺼낸 데이터는 앱 캐시에 해시 이름으로 저장한다.
 */
import zlib from 'node:zlib';

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
export const MAX_ZIP_ENTRIES = 5000;
export const MAX_ENTRY_BYTES = 200 * 1024 * 1024;

export const IMAGE_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.avif',
] as const;

export function readZipEntries(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new Error('ZIP 파일이 아닙니다');
  const minStart = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 중앙 디렉터리를 찾지 못했습니다');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 는 지원하지 않습니다');
  if (count > MAX_ZIP_ENTRIES)
    throw new Error(`항목이 너무 많습니다 (최대 ${String(MAX_ZIP_ENTRIES)}개)`);
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG)
      throw new Error('중앙 디렉터리가 손상되었습니다');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    out.push({ name, method, flags, compressedSize, size, localOffset });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

export function readZipEntry(buf: Buffer, e: ZipEntry): Buffer {
  if (e.flags & 0x1) throw new Error('암호가 걸린 압축 파일은 열 수 없습니다');
  if (e.size > MAX_ENTRY_BYTES) throw new Error('항목이 너무 큽니다');
  if (e.localOffset + 30 > buf.length || buf.readUInt32LE(e.localOffset) !== LOC_SIG) {
    throw new Error('로컬 헤더가 손상되었습니다');
  }
  const nlen = buf.readUInt16LE(e.localOffset + 26);
  const xlen = buf.readUInt16LE(e.localOffset + 28);
  const start = e.localOffset + 30 + nlen + xlen;
  const raw = buf.subarray(start, start + e.compressedSize);
  if (raw.length !== e.compressedSize) throw new Error('항목 데이터가 잘렸습니다');
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new Error(`지원하지 않는 압축 방식입니다 (${String(e.method)})`);
}

/** 맥 메타 폴더와 숨김 파일을 빼고 이미지 항목만 고른다 */
export function isImageEntryName(name: string): boolean {
  if (name.endsWith('/')) return false;
  if (name.startsWith('__MACOSX/') || name.includes('/__MACOSX/')) return false;
  const base = name.split('/').pop() ?? name;
  if (base.startsWith('.')) return false;
  const lower = base.toLowerCase();
  return IMAGE_EXTENSIONS.some((e) => lower.endsWith(e));
}

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

/** 파일 이름을 사람이 보는 순서로 정렬한다 (1, 2, 10 순서) */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

export function mimeOfImageName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.avif')) return 'image/avif';
  return 'image/jpeg';
}
