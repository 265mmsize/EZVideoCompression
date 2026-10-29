# 데이터베이스 스키마

SQLite 파일: `<userData>/videoslim.sqlite` (Windows 기본: `%APPDATA%/VideoSlim Desktop/`).
라이브러리: Node 내장 `node:sqlite` (`DatabaseSync`). 네이티브 애드온이 없어 Electron 버전마다 재빌드할 필요가 없다.
연결 시 `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000` 을 설정한다.

## 마이그레이션 규칙

- 버전은 `PRAGMA user_version` 으로 관리한다. 정의는 `src/main/database/migrations.ts`.
- 각 마이그레이션은 트랜잭션 안에서 실행되므로 중간 실패 시 부분 적용되지 않는다.
- 이미 배포된 마이그레이션은 수정하지 않는다. 변경은 새 번호로 추가한다.
- 저장된 버전이 앱보다 최신이면 시작을 거부한다 (다운그레이드 방지).

| 버전 | 내용                                                  |
| ---- | ----------------------------------------------------- |
| 1    | `jobs`, `job_events`, `settings` 테이블               |
| 2    | `jobs.recommendation_json` 컬럼 (샘플 품질 추천 결과) |
| 3    | 미디어 라이브러리 테이블 (아래 절)                    |
| 4    | `edit_projects` (영상 편집 프로젝트, JSON 전체 저장)  |

## 테이블

### jobs

| 컬럼                                  | 타입    | 설명                                                          |
| ------------------------------------- | ------- | ------------------------------------------------------------- |
| id                                    | TEXT PK | 작업 ID (UUID)                                                |
| input_path                            | TEXT    | 입력 경로 (표시와 열기에 사용)                                |
| input_path_key                        | TEXT    | 정규화 경로 (중복 검사용, Windows 는 소문자)                  |
| file_name                             | TEXT    | 파일명                                                        |
| input_size_bytes                      | INTEGER | 등록 시 크기 (변경 감지)                                      |
| input_mtime_ms                        | REAL    | 등록 시 수정 시간 (변경 감지)                                 |
| status                                | TEXT    | 작업 상태 (`JOB_STATUSES`)                                    |
| status_message                        | TEXT    | 화면용 한 줄 설명                                             |
| settings_json                         | TEXT    | `JobSettings` (모드, 프리셋, 컨테이너, 코덱, 목표, 트랙, CRF) |
| probe_json                            | TEXT    | `ProbeResult` (ffprobe 분석 결과)                             |
| analysis_json                         | TEXT    | `AnalysisResult` (지원 판정, 트랙 정책, 예상 결과)            |
| progress_json                         | TEXT    | 마지막 진행률                                                 |
| output_path                           | TEXT    | 확정된 결과 경로 (없으면 NULL)                                |
| output_size_bytes                     | INTEGER | 결과 크기 (no_savings 는 보관하지 않아도 기록)                |
| savings_ratio                         | REAL    | 실제 절감률 (음수면 증가)                                     |
| error_code                            | TEXT    | `ERROR_CODES` 중 하나                                         |
| error_detail                          | TEXT    | 기술 상세                                                     |
| validation_json                       | TEXT    | `ValidationReport`                                            |
| recommendation_json                   | TEXT    | `QualityRecommendation` (2 이후)                              |
| encoder_name                          | TEXT    | 실제 사용한 인코더 설명 (대체 기록 포함)                      |
| encoder_version                       | TEXT    | `ffmpeg -version` 첫 줄                                       |
| avg_speed                             | REAL    | 실측 속도 (배수). 이후 처리 시간 추정에 사용                  |
| temp_output_path                      | TEXT    | 임시 출력 경로 (중단 복구용)                                  |
| temp_dir                              | TEXT    | 작업 임시 디렉터리 (중단 복구용)                              |
| queue_order                           | INTEGER | 대기열 순서                                                   |
| created_at / started_at / finished_at | TEXT    | ISO 8601 시각                                                 |

인덱스: `status`, `queue_order`, `input_path_key`.

### job_events

작업 상태 전이 기록. `job_id` 가 `jobs.id` 를 참조하며 작업 삭제 시 함께 삭제된다 (`ON DELETE CASCADE`).

| 컬럼                    | 설명           |
| ----------------------- | -------------- |
| id                      | 자동 증가      |
| job_id                  | 작업 ID        |
| at                      | 시각           |
| from_status / to_status | 전이 전후 상태 |
| message                 | 상태 메시지    |

### settings

키-값 저장소. 키 `app` 에 `AppSettings` 를 JSON 으로 저장한다.
읽을 때는 기본값과 깊게 병합하고 zod 로 검증한다. 검증에 실패하면 기본값을 쓰며 앱은 계속 실행된다.

## 기록 정책

- 작업 기록 삭제(`jobs:remove`)는 행만 지운다. 원본 파일과 결과 파일은 건드리지 않는다.
- 실행 중인 작업은 삭제할 수 없다.
- 중단 복구는 DB 에 기록된 임시 경로만 지운다. DB 에 없는 임시 디렉터리는 앱이 만든 것이므로 시작 시 정리한다.

## 미디어 라이브러리 (마이그레이션 3)

| 테이블                              | 설명                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `library_roots`                     | 등록 폴더. `path_key` 는 정규화 경로(유일). 하위 폴더 포함 여부, 마지막 인덱싱 시각                                                                                      |
| `library_items`                     | 파일 항목. `path_key` 유일. 종류(video/image), 크기·수정 시간(변경 감지), 해상도·길이·코덱·컨테이너, 축약 probe JSON, `missing`(마지막 인덱싱에서 못 찾음), `error_code` |
| `library_meta`                      | 평점(0~5)·라벨·메모. **경로 키 기준**이라 항목이 지워졌다 다시 생겨도 유지된다. 파일에는 쓰지 않는다                                                                     |
| `library_tags`, `library_item_tags` | 태그 사전과 항목(경로 키)-태그 연결. 쓰이지 않는 태그는 자동 정리                                                                                                        |
| `thumbnails`                        | 썸네일·프레임·변환 이미지 캐시(JPEG) 목록. 키 = sha1(경로 키, 크기, 수정 시간, 변형). 최근 사용 시각으로 LRU 정리                                                        |
| `previews`                          | 미리보기 변환본(`proxy`)과 설정 미리보기(`settings`) 파일 기록. 작업 결과와 별개                                                                                         |

인덱스: `library_items(root_id)`, `(parent_dir_key)`, `(kind)`, `(size_bytes)`, `previews(source_key)`.
압축 연결은 `library_items.path_key = jobs.input_path_key` 조인으로 계산하며 저장하지 않는다.
