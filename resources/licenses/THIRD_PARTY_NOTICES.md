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

## 3. FFmpeg / ffprobe (Windows 번들, GPL v3)

Windows 빌드에는 FFmpeg 6.0 (gyan.dev essentials 빌드, GPL v3) 의 ffmpeg.exe, ffprobe.exe 가 들어 있다.
출처와 무결성 값은 scripts/fetch-ffmpeg-win.mjs 에 고정되어 있다. 라이선스 전문은 resources/licenses/ffmpeg/COPYING.GPLv3 이다.
이 빌드는 GPL 구성요소(libx264, libx265 등)를 포함하므로 배포자는 대응 소스 제공 의무를 이행해야 한다 (docs/RELEASE_CHECKLIST.md 2절).
