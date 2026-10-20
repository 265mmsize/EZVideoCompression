import crypto from 'node:crypto';
import fs from 'node:fs';

/** 파일 내용 SHA-256. 원본 보호 검증에 사용한다. */
export function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
