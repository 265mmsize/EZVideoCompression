# VideoSlim Desktop

여러 형식의 영상을 로컬에서 분석하고, 선택한 조건 안에서 파일 크기를 줄이는 Windows 데스크톱 앱입니다.
영상은 인터넷으로 업로드하지 않으며, 원본은 어떤 경우에도 덮어쓰거나 삭제하지 않습니다.

> **현재 상태**: 1~5단계 중 모든 항목을 완료하지는 못했습니다. 구현 상태와 미구현 목록은
> [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) 를 보세요.
> Windows 빌드에는 FFmpeg 6.0 (GPL v3) 이 번들됩니다. 배포자는 GPL 소스 제공 의무를 이행해야 하며,
> 설치 파일은 서명되지 않습니다. 설치 파일은 Windows 또는 wine(32·64비트)이 있는 Linux 에서 만듭니다.

## 주요 기능

- **미디어 라이브러리 (1.1.0)**: 폴더 등록·인덱싱, 썸네일 그리드와 스크럽, 평점·라벨·태그·필터, 중복 후보, 압축 대기열 연결
- **재생 미리보기**: 직접 재생 → 프레임 보기 → 변환본 순서의 폴백, 원본·결과 비교(나란히·전환·와이프·확대), 설정 미리보기(구간 실제 인코딩)

- 파일 선택, 다중 선택, 드래그앤드롭, 폴더 추가(하위 폴더 포함 선택)
- ffprobe 기반 분석: 코덱, 해상도, 픽셀 포맷, 비트 심도, 색 정보, HDR, 회전, 트랙별 처리 정책
- 압축 모드: 원본 유지(재인코딩 없음), 고품질 자동(기본), 빠른 압축, 목표 용량(MiB, 2-pass)
- 샘플 품질 추천: 짧은 구간 여러 곳을 SSIM 으로 비교해 CRF 를 제안 (샘플 평가임을 명시)
- 작업 큐: 동시 인코딩 1개, 순서 변경, 취소, 재시도, 일시정지(현재 작업 완료 후 중지)
- **이미지 편집 (1.3.0)**: 자르기·회전·뒤집기·미세 회전·크기 조정, 화질 보정(선명하게·노이즈 제거·밝기/대비/채도/감마·자동 레벨, FFmpeg 필터이며 AI 아님), 화면 캡처. 원본은 수정하지 않고 새 파일로 저장
- 외부 자막 자동 감지 (1.2.0): 같은 폴더의 `영상.srt`, `영상.ko.srt` 등을 찾아 결과에 포함 (CP949·UTF-16 자막도 UTF-8 로 변환해 포함, 원본은 수정하지 않음)
- 결과 검증 후 같은 폴더에 확정 저장, 결과가 더 크면 `no_savings` 로 표시
- 재실행 시 중단된 작업 감지, SQLite 이력, 로그 내보내기(경로 마스킹 옵션)

## 요구 사항

- Windows 11 x64 (우선 지원). 개발은 Linux 컨테이너에서도 가능합니다.
- Node.js 22.13 이상 (Electron 44 는 번들 Node 24 를 사용합니다)
- FFmpeg 5.1 이상 (`ffmpeg`, `ffprobe`). 설정에서 경로를 지정하거나 PATH 에 두세요.
  - 소프트웨어 인코더 `libx264`, `libx265` 가 포함된 빌드가 필요합니다.

## 개발 환경 실행

```bash
npm ci                 # package-lock.json 기준으로 정확히 설치
npm run dev            # Electron 개발 실행 (electron-vite)
```

## 검사와 테스트

```bash
npm run typecheck      # main/preload 와 renderer 타입 검사
npm run lint           # ESLint (strict type-checked)
npm run format:check   # Prettier
npm test               # 단위 + 통합 (실제 FFmpeg 사용, 픽스처 자동 생성)
npm run test:e2e       # Electron E2E (빌드 후 실행, Linux 에서는 xvfb-run 사용)
npm run fixtures       # 테스트 합성 영상만 생성 (tests/fixtures/generated/, 커밋 제외)
```

테스트 구성:

- `tests/unit/`: 정책, 상태 전이, 파싱, 파일 확정, 샘플 판정, 하드웨어 인자
- `tests/integration/`: 실제 FFmpeg 로 분석·압축·검증·취소·복구·추천·CPU 대체
- `tests/e2e/`: Electron 창에서 파일 추가 → 분석 → 시작 → 확정 → 이력 확인, 패키지 앱 스모크

결과와 미검증 범위는 [docs/TEST_REPORT.md](docs/TEST_REPORT.md) 에 있습니다.

## 빌드와 패키징

```bash
npm run build          # out/ 에 main, preload, renderer 빌드
npm run pack:linux-dir # Linux 패키지 (파이프라인 검증용)
npm run fetch:ffmpeg    # FFmpeg 6.0 Windows 바이너리를 SHA-256 검증 후 resources/binaries/win32-x64 에 배치
npm run pack:win         # Windows NSIS 설치 파일과 포터블 실행 파일 (Windows, 또는 wine64·wine32 + xvfb 가 있는 Linux)
npm run verify:win       # 생성된 설치 파일·포터블을 7z 로 해부해 페이로드·FFmpeg 해시·라이선스·버전 정보 확인
node scripts/gen-licenses.mjs   # 제3자 라이선스 고지 재생성
```

`release/` 에 `VideoSlim Desktop-Setup-<버전>-x64.exe` 와 `VideoSlim Desktop-Portable-<버전>-x64.exe` 가 생성됩니다. 배포 전 체크리스트는 [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) 를 따르세요.

## 프로젝트 구조

```
src/main/          Electron 메인: ipc, services, repositories, database, platform
src/preload/       contextBridge 로 노출하는 제한된 API
src/renderer/      React 화면 (components, pages, hooks, stores, styles)
src/shared/        도메인 타입, IPC 계약, zod 스키마 (메인과 렌더러 공유)
resources/         번들 바이너리 위치(binaries), 라이선스(licenses)
tests/             unit, integration, e2e, fixtures
docs/              아키텍처, 압축 정책, 지원 형식, DB 스키마, 테스트 결과, 구현 상태, 배포 체크리스트
scripts/           라이선스 고지 생성
```

## 문서

- [아키텍처](docs/ARCHITECTURE.md)
- [압축 정책](docs/COMPRESSION_POLICY.md)
- [지원 형식과 제한](docs/SUPPORT_MATRIX.md)
- [구현 상태와 미구현 목록](docs/IMPLEMENTATION_STATUS.md)
- [DB 스키마와 마이그레이션](docs/DB_SCHEMA.md)
- [테스트 결과](docs/TEST_REPORT.md)
- [배포 체크리스트](docs/RELEASE_CHECKLIST.md)
- [릴리스 노트](docs/RELEASE_NOTES.md)
- [벤치마크: 미디어 관리·미리보기](docs/BENCHMARK_MEDIA_MANAGEMENT.md)
- [계획: 미디어 라이브러리](docs/PLAN_MEDIA_LIBRARY.md)
- [제3자 라이선스 고지](resources/licenses/THIRD_PARTY_NOTICES.md)

## 기술 선택

| 영역   | 선택                           | 이유                                           |
| ------ | ------------------------------ | ---------------------------------------------- |
| 앱 셸  | Electron 44                    | Windows 우선, macOS 확장 고려                  |
| 빌드   | electron-vite 6, Vite 8        | 메인·프리로드·렌더러를 하나의 설정으로 관리    |
| UI     | React 19, Tailwind 4           | 상태 관리 라이브러리 없이 구독형 스토어로 충분 |
| 검증   | zod 4                          | 메인이 렌더러 요청을 신뢰하지 않고 검사        |
| DB     | Node 내장 `node:sqlite`        | 네이티브 ABI 재빌드 불필요                     |
| 영상   | FFmpeg / ffprobe 별도 프로세스 | shell 없이 인자 배열로 실행                    |
| 테스트 | Vitest, Playwright(Electron)   | 실제 FFmpeg 와 실제 Electron 창으로 검증       |

## 라이선스

이 저장소에는 아직 프로젝트 라이선스 파일이 없습니다. 배포 전에 결정해야 합니다.
제3자 구성요소의 목록은 `resources/licenses/THIRD_PARTY_NOTICES.md` 에 있습니다.
