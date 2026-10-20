/**
 * SQLite 연결과 마이그레이션 실행.
 *
 * 설계 이유: Node 내장 node:sqlite(DatabaseSync)를 사용한다.
 * 네이티브 애드온이 없으므로 Electron 버전마다 ABI 재빌드가 필요 없고, 패키징이 단순해진다.
 * (Electron 44 / Node 24 에서 동작을 확인했다.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './migrations';

export type Db = DatabaseSync;

export function openDatabase(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function currentVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * 아직 적용되지 않은 마이그레이션을 순서대로 적용한다.
 * 현재 버전이 앱이 아는 최신 버전보다 크면(다운그레이드 실행) 오류로 막는다.
 */
export function migrate(db: Db): { from: number; to: number } {
  const from = currentVersion(db);
  const latest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  if (from > latest) {
    throw new Error(
      `데이터베이스 스키마(${String(from)})가 앱 버전(${String(latest)})보다 최신입니다`,
    );
  }
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.up);
      // user_version 은 PRAGMA 이므로 바인딩 파라미터를 쓸 수 없다. 정수만 쓰므로 안전하다.
      db.exec(`PRAGMA user_version = ${String(m.version)}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`마이그레이션 ${String(m.version)} (${m.description}) 실패: ${String(err)}`, {
        cause: err,
      });
    }
  }
  return { from, to: currentVersion(db) };
}
