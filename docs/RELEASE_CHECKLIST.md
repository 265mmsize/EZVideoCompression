# 배포 체크리스트

이 문서는 외부 배포 전에 확인할 항목이다. 현재 개발 환경에서 수행하지 않은 항목은 "미수행"으로 남긴다.
**사용자 승인 없이 외부에 게시하거나 배포하지 않는다.**

## 1. 빌드

- [ ] `npm ci` 로 `package-lock.json` 과 같은 의존성을 설치했다.
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` 가 통과한다.
- [ ] `npm test` (단위·통합) 가 통과한다. 통합 테스트는 FFmpeg 가 PATH 에 필요하다.
- [ ] `npm run test:e2e` (Electron, Linux 에서는 xvfb 사용) 가 통과한다.
- [ ] `npm run pack:win` 으로 NSIS 설치 파일과 포터블을 만들고 `npm run verify:win` 으로 내용을 검증한다. Windows 에서 실행하거나, Linux 에서는 `wine64`·`wine32:i386` 과 디스플레이(xvfb)가 필요하다.

## 2. FFmpeg 번들 (GPL v3 — 배포 전 필수 확인)

현재 번들: `scripts/fetch-ffmpeg-win.mjs` 가 PyPI `ffmpeg-binaries` 1.1.0 휠에서 FFmpeg 6.0 (gyan.dev essentials) 을 가져온다. 휠과 실행 파일의 SHA-256 은 스크립트에 고정되어 있다.

- [x] 출처와 빌드 구성을 기록했다: gyan.dev essentials 6.0, configure 옵션은 `resources/licenses/ffmpeg/BUILD-README.txt`, 원 소스 참조는 FFmpeg 커밋 ea3d24bbe3. 다만 휠은 제3자 재포장이므로 gyan.dev 원본과의 대조는 아직 하지 않았다.
- [x] 이 빌드는 `--enable-gpl` 이므로 GPL v3 가 적용된다. LGPL 빌드가 아니다. 배포자가 이 조건을 받아들이는지 결정해야 한다.
- [ ] 동적 링크 여부와 교체 가능성(사용자가 다른 FFmpeg 로 바꿀 수 있는지)을 확인했다.
- [ ] 라이선스 전문과 고지를 `resources/licenses/` 에 넣었다.
- [ ] 대응 소스 제공 방법을 정했다. FFmpeg 뿐 아니라 빌드에 포함된 GPL 구성요소(libx264, libx265, libvmaf, libvidstab 등)의 소스가 모두 필요하다. 서면 제안(written offer) 또는 소스 아카이브 중 하나를 택해 설치 파일과 함께 제공해야 한다.
- [ ] 코덱 특허·배포 조건(H.264, H.265)을 배포 대상 지역 기준으로 확인했다.
- [x] `resources/binaries/win32-x64/` 에 `ffmpeg.exe`, `ffprobe.exe` 를 SHA-256 검증 후 배치했다 (`npm run fetch:ffmpeg`).

## 3. 서명

- [ ] 코드 서명 인증서가 있으면 `win.signAndEditExecutable` 과 인증서 설정을 추가했다.
- [ ] 인증서가 없으면 **서명되지 않은 빌드**라고 릴리스 노트와 다운로드 페이지에 명시했다.

## 4. 깨끗한 환경 설치·실행 검증 (Windows 11 x64)

- [ ] 개발 도구가 없는 Windows 11 가상 머신에서 설치 파일을 실행했다.
- [ ] SmartScreen 경고 문구를 확인하고 문서와 대조했다 (서명이 없으므로 경고가 나온다).
- [ ] 설치 후 앱이 실행되고, FFmpeg 상태가 "찾음"으로 표시된다.
- [ ] 한글·공백 경로의 영상을 추가해 고품질 자동 모드로 압축하고, 결과가 확정된다.
- [ ] 원본의 해시가 처리 전후 같다.
- [ ] 진행 중 취소가 동작하고 임시 파일이 남지 않는다.
- [ ] 앱을 강제 종료 후 다시 실행하면 중단된 작업이 "중단됨"으로 표시된다.
- [ ] 제거 후 설치 폴더가 정리되고, 사용자 데이터(DB)는 정책대로 남거나 지워진다.
- [ ] GPU 가 없는 환경에서 빠른 압축이 CPU 로 동작한다.

## 5. 릴리스 노트에 적을 내용

- 지원 형식과 제한 사항 (`docs/SUPPORT_MATRIX.md`)
- 하드웨어 인코더의 미검증 상태
- 샘플 추천이 전체 영상 검증이 아니라는 점
- 서명 여부
- 로그 내보내기 시 경로 마스킹 옵션 사용 안내
