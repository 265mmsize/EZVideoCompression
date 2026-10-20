# 아키텍처

VideoSlim Desktop 은 Electron 앱이다. 영상 처리 로직은 UI 와 독립된 Node 모듈(`src/main/services`)에 있고,
Electron 에 의존하지 않으므로 단위·통합 테스트를 실제 FFmpeg 로 직접 실행할 수 있다.

## 1. 프로세스 책임

| 영역     | 위치                   | 책임                                                                        | 하지 않는 일                   |
| -------- | ---------------------- | --------------------------------------------------------------------------- | ------------------------------ |
| Main     | `src/main/`            | 파일 선택 대화상자, 경로 검증, 분석·인코딩·검증·확정, 작업 큐, SQLite, 로그 | 화면 렌더링                    |
| Preload  | `src/preload/index.ts` | `contextBridge` 로 제한된 API 공개, 채널 허용 목록, 이벤트 구독 해제        | 비즈니스 로직                  |
| Renderer | `src/renderer/`        | React 화면, 사용자 입력, 상태 표시                                          | 파일 시스템·프로세스 직접 접근 |
| Shared   | `src/shared/`          | 도메인 타입, 상태 전이표, 오류 카탈로그, IPC 계약, zod 스키마               | 런타임 의존성                  |

보안 설정: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
창의 새 창 열기는 차단하고, 앱 파일 외의 탐색은 막는다. 권한 요청은 모두 거부한다.
렌더러 HTML 에는 CSP(`default-src 'none'`, `connect-src 'none'`)를 두어 외부 리소스 로드를 막는다.

## 2. 메인 프로세스 모듈

```
container.ts              서비스 조립 (Electron 비의존, 테스트와 공유)
ipc/registerIpc.ts        채널별 zod 검증 → 핸들러 → { ok, data | error }
platform/logger.ts        파일 로거 (5 MB 회전, 작업 ID 태그, 경로 마스킹 내보내기)
services/
  FFmpegToolLocator.ts    ffmpeg/ffprobe 탐색 (설정 → 번들 → PATH) + 실제 -version 확인
  FFmpegProcessService.ts 프로세스 실행 (인자 배열, shell 없음, 진행률 파싱, 취소·타임아웃·멈춤 감지)
  MediaProbeService.ts    ffprobe JSON → ProbeResult (추측값은 unknown/estimated 로 표시)
  CapabilityService.ts    지원/제한/차단 판정, 트랙별 처리 정책, 목표 용량 계산 (순수 함수)
  CompressionPolicyService.ts  FFmpeg 인자 배열 생성 (CRF, 2-pass, 하드웨어 인코더 분기)
  JobRunner.ts            단일 작업 파이프라인: 입력 확인 → 인코딩 → 검증 → 확정
  OutputValidationService.ts   결과 기본 검증 (존재, 코덱, 해상도, 트랙, 길이, 디코딩, 패킷 수)
  FileFinalizeService.ts  임시 경로, 이름 충돌 회피, 링크 기반 무덮어쓰기 확정, 디스크 검사
  SampleEncodeService.ts  샘플 구간 SSIM 기반 품질 추천 (3단계)
  HardwareEncoderService.ts  NVENC/QSV/AMF 존재 확인 + 테스트 인코딩 (4단계)
  JobStateMachine.ts      허용 전이 검사
  JobQueueService.ts      큐 오케스트레이션: 분석 직렬, 인코딩 동시 1개, 일시정지, 취소, 복구
  ProgressEstimator.ts    진행률·ETA (지수 이동 평균, 워밍업 구간에서는 ETA 미표시)
repositories/              JobRepository, SettingsRepository (SQL 과 행 ↔ DTO 변환)
database/                  node:sqlite 연결, PRAGMA user_version 기반 마이그레이션
```

## 3. 데이터 흐름

### 3.1 등록과 분석

1. 렌더러가 파일 선택(`jobs:pickFiles`), 폴더 선택(`jobs:pickFolder`), 드롭(`jobs:addPaths`)을 요청한다.
2. 메인이 경로를 정규화하고 중복(진행 중인 같은 경로)을 거른 뒤 `probing` 으로 기록한다.
3. 분석은 직렬 체인에서 실행한다: `probing` → ffprobe → `analyzing` → 지원 판정 → `ready`.
4. 실패는 `failed` 와 오류 코드로 기록한다. 앱은 종료되지 않는다.

### 3.2 인코딩

1. 사용자가 "시작"을 누르면 `ready` → `queued`. 일시정지 상태가 아니면 큐가 맨 앞 작업을 `encoding` 으로 바꾼다.
2. `JobRunner.encode`:
   - 입력 파일의 크기·수정 시간이 분석 시점과 같은지 확인 (`INPUT_CHANGED`).
   - 차단된 설정이면 실행하지 않는다 (`UNSUPPORTED_SETTINGS`).
   - 출력 폴더에 임시 파일 경로(`.<이름>.vslim-tmp-<ID8>.<확장자>`)를 정하고 디스크 여유를 확인한다.
   - FFmpeg 패스를 순서대로 실행하고 종료 코드를 확인한다.
   - `validating` 으로 바꾸고 `OutputValidationService` 로 기본 검증을 한다.
   - 취소 여부를 한 번 더 확인한 뒤, 결과가 원본보다 작으면 같은 볼륨에서 확정한다. 크면 `no_savings`.
3. 목표 용량 모드는 결과가 목표를 넘으면 비트레이트를 낮춰 최대 3회까지 다시 인코딩한다. 그래도 넘으면 `TARGET_EXCEEDED`.
4. 성공·실패·취소와 무관하게 작업 전용 임시 디렉터리(`userData/tmp/<jobId>`)를 지운다.

### 3.3 상태 전이

전이표는 `src/shared/types/domain.ts` 의 `JOB_TRANSITIONS` 가 유일한 원본이다. 허용되지 않은 전이는 `INVALID_STATE` 로 거부된다.
상세 표는 `docs/IMPLEMENTATION_STATUS.md` 와 `tests/unit/stateMachine.test.ts` 에 있다.

### 3.4 복구

앱 시작 시 `probing`, `analyzing`, `queued`, `encoding`, `validating` 상태의 작업은 `interrupted` 로 바꾸고,
DB 에 기록된 임시 출력 파일과 임시 디렉터리만 지운다. `cancelling` 은 `cancelled` 로 바꾼다.
DB 에 기록이 없는 임시 디렉터리도 앱이 만든 것이므로 정리한다. 원본과 사용자 파일은 건드리지 않는다.

## 4. IPC 계약

- 채널 목록과 요청·응답 타입은 `src/shared/contracts/ipc.ts` 가 유일한 원본이다.
- 요청 검증은 `src/shared/schemas/ipc.schemas.ts` 의 zod 스키마로 한다. 경로는 널 문자를 거부한다.
- 오류는 `{ ok: false, error: { code, detail } }` 로 돌려준다. 렌더러는 코드를 `ERROR_CATALOG` 에서 찾아
  제목·원인·해결 방법을 보여준다. 원시 예외 객체는 노출하지 않는다.
- 푸시 이벤트: `job:changed`, `job:removed`, `queue:changed`, `tools:changed`. 진행률 이벤트는 200 ms 간격으로 줄인다.

## 5. 저장 데이터

`docs/DB_SCHEMA.md` 참조. 저장소는 `node:sqlite` 이다. 네이티브 애드온이 없으므로 Electron 버전마다 ABI 재빌드가 필요 없다.

## 6. 확장 지점

- 새 인코더: `CompressionPolicyService` 에 인자 생성을 추가하고, 인코더별 품질 표를 따로 둔다.
- 새 입력 특성: `CapabilityService.analyzeCapability` 에 제한 항목을 추가한다. 차단인지 경고인지 severity 로 정한다.
- 새 검증: `OutputValidationService.validate` 에 체크를 추가한다. 실패 시 확정하지 않는다.
- 새 채널: `InvokeContract`, `invokeSchemas`, `registerIpc` 의 핸들러 맵 세 곳을 함께 고친다. 타입 검사가 누락을 잡는다.
