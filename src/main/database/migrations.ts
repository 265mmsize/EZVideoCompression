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
  {
    version: 2,
    description: '샘플 품질 추천 결과 컬럼',
    up: `ALTER TABLE jobs ADD COLUMN recommendation_json TEXT;`,
  },
  {
    version: 3,
    description: '미디어 라이브러리: 등록 폴더, 항목, 메타, 태그, 썸네일·미리보기 캐시',
    up: `
      CREATE TABLE library_roots (
        id                  TEXT PRIMARY KEY,
        path                TEXT NOT NULL,
        path_key            TEXT NOT NULL UNIQUE,
        include_subfolders  INTEGER NOT NULL,
        added_at            TEXT NOT NULL,
        last_indexed_at     TEXT
      );

      CREATE TABLE library_items (
        id              TEXT PRIMARY KEY,
        root_id         TEXT NOT NULL REFERENCES library_roots(id) ON DELETE CASCADE,
        path            TEXT NOT NULL,
        path_key        TEXT NOT NULL UNIQUE,
        parent_dir      TEXT NOT NULL,
        parent_dir_key  TEXT NOT NULL,
        file_name       TEXT NOT NULL,
        kind            TEXT NOT NULL,
        size_bytes      INTEGER NOT NULL,
        mtime_ms        REAL NOT NULL,
        width           INTEGER,
        height          INTEGER,
        duration_sec    REAL,
        video_codec     TEXT,
        audio_codec     TEXT,
        container       TEXT,
        probe_json      TEXT,
        indexed_at      TEXT,
        missing         INTEGER NOT NULL DEFAULT 0,
        error_code      TEXT
      );
      CREATE INDEX idx_library_items_root ON library_items(root_id);
      CREATE INDEX idx_library_items_dir ON library_items(parent_dir_key);
      CREATE INDEX idx_library_items_kind ON library_items(kind);
      CREATE INDEX idx_library_items_size ON library_items(size_bytes);

      -- 메타는 경로 키 기준으로 보관해 재인덱싱(항목 재생성) 후에도 유지된다
      CREATE TABLE library_meta (
        path_key   TEXT PRIMARY KEY,
        rating     INTEGER NOT NULL DEFAULT 0,
        label      TEXT,
        note       TEXT
      );

      CREATE TABLE library_tags (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        name  TEXT NOT NULL UNIQUE
      );
      CREATE TABLE library_item_tags (
        path_key  TEXT NOT NULL,
        tag_id    INTEGER NOT NULL REFERENCES library_tags(id) ON DELETE CASCADE,
        PRIMARY KEY (path_key, tag_id)
      );

      CREATE TABLE thumbnails (
        cache_key     TEXT PRIMARY KEY,
        file          TEXT NOT NULL,
        bytes         INTEGER NOT NULL,
        created_at    TEXT NOT NULL,
        last_used_at  TEXT NOT NULL
      );

      CREATE TABLE previews (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        source_key     TEXT NOT NULL,
        file           TEXT NOT NULL,
        bytes          INTEGER NOT NULL,
        duration_sec   REAL,
        settings_json  TEXT,
        start_sec      REAL,
        note           TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        last_used_at   TEXT NOT NULL
      );
      CREATE INDEX idx_previews_source ON previews(source_key);
    `,
  },
  {
    version: 4,
    description: '영상 편집 프로젝트',
    up: `
      CREATE TABLE edit_projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        json        TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
