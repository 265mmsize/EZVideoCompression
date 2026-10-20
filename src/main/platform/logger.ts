/**
 * 파일 로거.
 *
 * - 작업별 식별자(jobId)를 각 줄에 붙여 지원용 로그에서 추적할 수 있게 한다.
 * - 파일 크기 상한을 넘으면 회전한다 (app.log → app.1.log → app.2.log).
 * - 외부 의존성 없이 동기 append 를 사용한다. 로그량이 적고 순서 보장이 더 중요하다.
 */
import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  jobId?: string;
  [key: string]: unknown;
}

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROTATIONS = 3;

export class Logger {
  private readonly file: string;
  private echoToConsole: boolean;

  constructor(dir: string, options?: { echoToConsole?: boolean }) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'app.log');
    this.echoToConsole = options?.echoToConsole ?? false;
  }

  get filePath(): string {
    return this.file;
  }

  debug(msg: string, fields?: LogFields): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.write('error', msg, fields);
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}]${
      fields?.jobId ? ` [job:${fields.jobId}]` : ''
    } ${msg}${fields ? ` ${safeJson(fields)}` : ''}\n`;
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, line, 'utf8');
    } catch {
      // 로그 실패가 앱 동작을 막으면 안 된다.
    }
    if (this.echoToConsole) {
      console.log(line.trimEnd());
    }
  }

  private rotateIfNeeded(): void {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size < MAX_BYTES) return;
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const from = this.rotated(i);
      const to = this.rotated(i + 1);
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(this.file, this.rotated(1));
  }

  private rotated(n: number): string {
    return this.file.replace(/\.log$/, `.${n}.log`);
  }

  /**
   * 지원용 로그 내보내기. maskPaths 가 true 이면 경로처럼 보이는 문자열을 가린다.
   * 완전한 익명화는 아니며, 파일명·폴더명 등 개인정보 노출을 줄이는 용도다.
   */
  exportTo(target: string, maskPaths: boolean): void {
    const parts: string[] = [];
    for (let i = MAX_ROTATIONS; i >= 1; i--) {
      const f = this.rotated(i);
      if (fs.existsSync(f)) parts.push(fs.readFileSync(f, 'utf8'));
    }
    if (fs.existsSync(this.file)) parts.push(fs.readFileSync(this.file, 'utf8'));
    let text = parts.join('');
    if (maskPaths) text = maskPathsInText(text);
    fs.writeFileSync(target, text, 'utf8');
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val: unknown) =>
      typeof val === 'bigint' ? val.toString() : val,
    );
  } catch {
    return '"<unserializable>"';
  }
}

/** Windows 드라이브 경로, UNC 경로, POSIX 절대 경로를 <path> 로 치환한다. */
export function maskPathsInText(text: string): string {
  return text
    .replace(/[A-Za-z]:\\(?:[^\\"\s,}]+\\?)+/g, '<path>')
    .replace(/\\\\[^\\"\s,}]+(?:\\[^\\"\s,}]+)+/g, '<path>')
    .replace(/(?<![\w:])\/(?:[^/"\s,}]+\/?)+/g, '<path>');
}
