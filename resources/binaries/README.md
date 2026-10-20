# 번들 바이너리 위치

앱은 FFmpeg 를 다음 순서로 찾는다.

1. 설정 화면에서 사용자가 지정한 경로 (`ffmpegPath`, `ffprobePath`)
2. 번들 디렉터리: `resources/binaries/<platform>-<arch>/` (패키징 후에는 앱 설치 폴더의 `resources/binaries/`)
3. 시스템 PATH

탐색 결과는 실제로 `-version` 을 실행해 확인한다. 파일이 있다는 것만으로는 사용하지 않는다.
FFmpeg 5.1 미만이면 지원 범위 밖으로 판정한다.

## 폴더 규칙

| 폴더                           | 대상                       |
| ------------------------------ | -------------------------- |
| `win32-x64/`                   | Windows 11 x64 (우선 지원) |
| `darwin-arm64/`, `darwin-x64/` | macOS (확장 예정, 미검증)  |
| `linux-x64/`                   | 개발·테스트용              |

바이너리 파일(`ffmpeg`, `ffprobe`, `.exe`)은 저장소에 커밋하지 않는다 (`.gitignore` 로 제외).

## 번들하기 전 확인할 것

- LGPL 빌드를 우선 사용하고 GPL 구성요소의 포함 여부를 확인한다.
- 출처 URL, 버전, configure 옵션, SHA-256 을 `docs/RELEASE_CHECKLIST.md` 절차에 따라 기록한다.
- 라이선스 전문과 고지를 `resources/licenses/` 에 넣는다.
- 이 저장소의 빌드 환경에서는 해당 호스트 접근이 차단되어 있어 바이너리를 내려받지 않았다.
  실제 번들은 배포 담당자가 위 절차를 거쳐 추가해야 한다.

## 테스트용 FFmpeg 지정

통합 테스트는 PATH 의 `ffmpeg` 를 쓴다. 다른 경로를 쓰려면 환경 변수 `FFMPEG_PATH` 를 지정한다 (`.env.example` 참조).
