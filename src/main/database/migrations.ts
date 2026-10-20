/**
 * SQLite 스키마 마이그레이션.
 *
 * - 버전은 PRAGMA user_version 으로 관리한다. 번호는 1부터 증가하며 이미 배포된 항목은 수정하지 않는다.
 * - 각 마이그레이션은 트랜잭션 안에서 실행되므로 중간 실패 시 부분 적용되지 않는다.
 * - 새 변경은 항상 새 번호로 추가한다.
 */

export interface Migration {
  version: number;
  description: string;
  up: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: '작업 큐, 작업 이벤트, 설정 테이블',
    up: `
      CREATE TABLE jobs (
        id                  TEXT PRIMARY KEY,
        input_path          TEXT NOT NULL,
        input_path_key      TEXT NOT NULL,
        file_name           TEXT NOT NULL,
        input_size_bytes    INTEGER NOT NULL,
        input_mtime_ms      REAL NOT NULL,
        status              TEXT NOT NULL,
        status_message      TEXT,
        settings_json       TEXT NOT NULL,
        probe_json          TEXT,
        analysis_json       TEXT,
        progress_json       TEXT,
        output_path         TEXT,
        output_size_bytes   INTEGER,
        savings_ratio       REAL,
        error_code          TEXT,
        error_detail        TEXT,
        validation_json     TEXT,
        encoder_name        TEXT,
        encoder_version     TEXT,
        avg_speed           REAL,
        temp_output_path    TEXT,
        temp_dir            TEXT,
        queue_order         INTEGER NOT NULL,
        created_at          TEXT NOT NULL,
        started_at          TEXT,
        finished_at         TEXT
      );
      CREATE INDEX idx_jobs_status ON jobs(status);
      CREATE INDEX idx_jobs_queue_order ON jobs(queue_order);
      CREATE INDEX idx_jobs_path_key ON jobs(input_path_key);

      CREATE TABLE job_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        at          TEXT NOT NULL,
        from_status TEXT,
        to_status   TEXT NOT NULL,
        message     TEXT
      );
      CREATE INDEX idx_job_events_job ON job_events(job_id);

      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
