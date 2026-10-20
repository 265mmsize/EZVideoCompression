# 제3자 소프트웨어 고지 (Third-Party Notices)

생성일: 2026-10-20 (scripts/gen-licenses.mjs 로 생성, 수동 편집 금지)

## 1. 런타임 npm 의존성

| 패키지    | 버전   | 라이선스 | 저장소                                    |
| --------- | ------ | -------- | ----------------------------------------- |
| react     | 19.3.1 | MIT      | https://github.com/react/react.git        |
| react-dom | 19.3.1 | MIT      | https://github.com/react/react.git        |
| scheduler | 0.28.0 | MIT      | https://github.com/react/react.git        |
| zod       | 4.6.7  | MIT      | git+https://github.com/colinhacks/zod.git |

## 2. Electron (런타임)

Electron 은 MIT 라이선스이며, 번들에 포함된 Chromium 과 Node.js 의 고지는 설치 폴더의 LICENSE.electron.txt 와 LICENSES.chromium.html 을 따른다.

## 3. FFmpeg / ffprobe (번들하지 않음)

현재 배포 빌드에는 FFmpeg 바이너리가 포함되어 있지 않다. 사용자가 설정에서 지정하거나 PATH 의 FFmpeg 를 사용한다.
번들 배포로 전환할 때는 resources/binaries/README.md 의 조건(LGPL 빌드, 소스 제공, 빌드 구성 기록)을 충족해야 한다.
