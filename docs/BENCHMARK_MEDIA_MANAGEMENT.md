# 벤치마크: 영상·이미지 파일 관리와 재생 미리보기

작성일: 2026-10-27. 목적: VideoSlim Desktop 에 "파일 관리"와 "재생 미리보기"를 추가하기 전에,
널리 쓰이는 프로그램이 무엇을 어떻게 제공하는지 확인하고 우리 제품에 맞는 범위를 고른다.

근거 등급

- **A**: 제작사 공식 문서·공식 페이지에서 확인
- **B**: 제작사 블로그·릴리스 노트·커뮤니티 포럼에서 확인
- **C**: 제3자 리뷰·다운로드 사이트 (세부 동작은 미확인)
- **M**: 이 저장소 환경에서 직접 측정

## 1. 비교 대상과 포지션

| 제품                   | 분류                   | 비용                | 핵심 포지션                                                            |
| ---------------------- | ---------------------- | ------------------- | ---------------------------------------------------------------------- |
| XnView MP              | 이미지 브라우저·뷰어   | 무료(개인)          | 탐색기형 썸네일 브라우저, 500+ 포맷 읽기, 배치 변환·이름 바꾸기        |
| FastStone Image Viewer | 이미지 뷰어·브라우저   | 무료(개인)          | 전체 화면 뷰어 + 숨은 툴바, 비교, 평점·태그 (7.6+)                     |
| digiKam                | 사진·영상 카탈로그     | 무료(오픈소스)      | DB 기반 앨범·태그, 유사 이미지(중복) 검색, FFmpeg 로 영상 카탈로그     |
| Adobe Bridge           | 자산 브라우저          | Creative Cloud 포함 | 썸네일 위에서 영상 스크럽, 미리보기 패널 재생, 키워드·평점·라벨·컬렉션 |
| Eagle                  | 디자이너용 자산 관리자 | 유료                | 90+ 포맷 미리보기, 태그·스마트 폴더, 색상·크기·평점 필터               |
| HandBrake              | 트랜스코더             | 무료(오픈소스)      | 인코딩 설정의 "미리보기": 구간을 실제 인코딩해 결과를 재생             |
| VLC / PotPlayer        | 플레이어               | 무료                | 재생 자체가 목적. VLC 는 탐색바 썸네일 미리보기를 제공하지 않음        |

## 2. 기능 비교표

범례: ✅ 있음 / ◐ 부분 / ✗ 없음 / ? 미확인. 괄호는 근거 등급.

### 2.1 파일 관리

| 기능                           | XnView MP       | FastStone               | digiKam                 | Bridge                | Eagle                         |
| ------------------------------ | --------------- | ----------------------- | ----------------------- | --------------------- | ----------------------------- |
| 폴더 트리 + 썸네일 그리드      | ✅ (C)          | ✅ (A)                  | ✅ (A)                  | ✅ (B)                | ✅ (C)                        |
| 영상 파일을 같은 목록에서 관리 | ◐ 일부 포맷 (C) | ◐ (C)                   | ✅ FFmpeg 카탈로그 (A)  | ✅ (A)                | ✅ (C)                        |
| 평점(별)                       | ?               | ✅ 1~5, 필터·단축키 (B) | ✅ (A)                  | ✅ (B)                | ✅ (C)                        |
| 색상 라벨                      | ?               | ✅ 색상 코드 평점 (B)   | ✅ (A)                  | ✅ (B)                | ◐ 자동 색상 추출 (C)          |
| 태그·키워드                    | ?               | ✅ 파일 태깅 (C)        | ✅ 가상 앨범 (A)        | ✅ 키워드 패널 (C)    | ✅ 자동 태그·일괄 태그 (C)    |
| 컬렉션·스마트 폴더             | ?               | ✗                       | ✅ 태그 = 가상 앨범 (A) | ✅ 검색 결과 저장 (C) | ✅ 스마트 폴더 (C)            |
| 필터(종류·날짜·크기·평점)      | ?               | ✅ 평점 필터 (B)        | ✅ (A)                  | ✅ 검색 (C)           | ✅ 색·형태·평점·치수·날짜 (C) |
| 중복 찾기                      | ✅ (C)          | ✗                       | ✅ 지문 기반 유사도 (A) | ✗                     | ?                             |
| 배치 이름 바꾸기               | ✅ (C)          | ✅ 7.6+ (B)             | ✅                      | ✅                    | ?                             |
| 메타데이터 편집(EXIF/XMP)      | ✅              | ◐                       | ✅ (A)                  | ✅ (C)                | ◐ 메모·URL                    |
| 이동·복사 시 메타 유지         | ?               | ✅ 태그·평점 유지 (B)   | ✅                      | ✅                    | ✅                            |

### 2.2 미리보기·재생

| 기능                                   | XnView MP | FastStone | digiKam          | Bridge                     | Eagle  | HandBrake                             |
| -------------------------------------- | --------- | --------- | ---------------- | -------------------------- | ------ | ------------------------------------- |
| 이미지 즉시 미리보기                   | ✅        | ✅        | ✅               | ✅                         | ✅     | -                                     |
| 영상 썸네일 생성                       | ◐         | ◐         | ✅ (A)           | ✅ (A)                     | ✅ (C) | ✅ 미리보기 이미지                    |
| 썸네일 위 마우스 스크럽                | ✗         | ✗         | ✗                | ✅ 설정에서 켬 (A/B)       | ?      | ✗                                     |
| 패널 내 영상 재생(재생·일시정지·음량)  | ◐         | ✗         | ✅               | ✅ 64비트 Windows 필요 (A) | ✅ (C) | ✅ 인코딩 결과 재생 (A)               |
| 인코딩 결과 미리보기(구간 실제 인코딩) | ✗         | ✗         | ✗                | ✗                          | ✗      | ✅ 위치·길이 지정 후 Live Preview (A) |
| 두 파일 나란히 비교                    | ✅ (C)    | ✅ (A/C)  | ✅ 라이트 테이블 | ✅ 비교 모드               | ◐      | ✗                                     |
| 탐색바 썸네일(플레이어)                | -         | -         | -                | -                          | -      | VLC ✗ (B, 오래된 스레드)              |

관찰

1. 관리 기능의 공통분모는 **폴더 트리 + 썸네일 그리드 + 평점/라벨/태그 + 필터**다. 중복 찾기와 메타데이터 편집은 전문 도구(digiKam, XnView)의 영역이다.
2. 영상 미리보기의 두 축은 **(a) 썸네일 스크럽**(Bridge)과 **(b) 패널 재생**이다. 플레이어의 탐색바 썸네일은 VLC 조차 제공하지 않는다.
3. 인코더(HandBrake)의 미리보기는 "원본 재생"이 아니라 **설정을 적용한 구간을 실제로 인코딩해 보여주는 것**이다. 우리 3단계 샘플 추천(구간 SSIM)과 결합하면 차별점이 된다: 추천 CRF 후보를 바로 눈으로 비교하는 기능.

## 3. 이 환경에서 직접 측정한 것 (M)

Electron 44.9.1 (Chromium 152) 렌더러에서 `video.canPlayType` 결과 (Linux, GPU 없음):

| 형식                     | 결과     | 의미                                                                                            |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------------- |
| MP4 / H.264              | probably | 직접 재생 가능                                                                                  |
| MP4 / AV1                | probably | 직접 재생 가능                                                                                  |
| WebM / VP9, VP8          | probably | 직접 재생 가능                                                                                  |
| MKV (`video/x-matroska`) | maybe    | 컨테이너는 열 수 있으나 코덱·트랙 구성에 따라 실패 가능                                         |
| MP4 / HEVC               | **no**   | 이 환경에서는 불가. Windows 에서는 GPU 의 하드웨어 디코더가 있을 때만 가능하며, 장치별로 다르다 |
| AAC, Opus                | probably | 음성 재생 가능                                                                                  |
| AC-3                     | **no**   | 복사 모드로 만든 AC-3 음성은 브라우저 재생 불가                                                 |

이미지 디코딩은 헤드리스 환경에서 측정이 멈춰 공개 문서 기준으로 적는다: Chromium 은 JPEG, PNG, GIF, WebP, BMP, ICO, AVIF 를 디코딩하고 **TIFF, HEIC/HEIF, RAW 는 디코딩하지 않는다**.
번들 FFmpeg 6.0 (gyan essentials) 은 TIFF·BMP·WebP·JPEG·PNG·GIF 를 디코딩하지만 **libheif 가 없어 HEIC 도 디코딩하지 못한다**.

결론: "브라우저 플레이어가 모든 입력을 재생한다"고 가정할 수 없다(요구사항 11절). 재생 전에 `canPlayType` 과 ffprobe 결과로 직접 재생 가능 여부를 판정하고, 불가능하면 FFmpeg 프레임 추출 → 미리보기 프록시 생성 순서로 내려간다.

## 4. 우리 제품에 가져올 것과 가져오지 않을 것

가져온다 (VideoSlim 의 "압축 전후 관리" 목적에 맞는 것)

- 폴더 트리 + 썸네일 그리드 + 리스트 전환, 종류·날짜·크기·해상도·코덱 필터, 정렬
- 평점(1~5), 색상 라벨, 태그 — 앱 DB 에 저장 (원본 파일의 메타데이터는 쓰지 않는다: 원본 보호 원칙)
- 영상 썸네일(여러 시점)과 썸네일 위 스크럽(Bridge 방식), 이미지 썸네일
- 패널 내 재생(직접 재생 가능할 때), 불가능하면 프레임 추출·프록시
- 압축 결과와 원본을 같은 시점으로 비교 (기존 미구현 "비교" 화면을 여기서 완성)
- 설정을 적용한 구간 미리보기 (HandBrake 방식) — 3단계 샘플 인코딩 재사용
- 중복 후보(크기·길이·해시 기준) 표시. 지각 해시 기반 유사도는 범위 밖

가져오지 않는다

- 원본 파일의 EXIF/XMP 편집, 파일 이동·삭제·이름 바꾸기 (원본을 건드리지 않는다는 제품 원칙과 충돌. 필요하면 "탐색기에서 열기"로 위임)
- 얼굴 인식, 지도, 클라우드 동기화, 브라우저 확장
- 플레이어 수준의 재생 기능(자막 렌더링, 음성 트랙 전환, 배속, 탐색바 썸네일)

## 5. 출처

- XnView MP: [What's different in XnView MP (공식 포럼)](https://newsgroup.xnview.com/viewtopic.php?p=97285), [FileHorse 소개](https://www.filehorse.com/download-xnview-mp-32), [giga.de 리뷰](https://www.giga.de/tipp/xnview-mp-download-kostenlose-bildbearbeitung-mit-umfangreichen-funktionen/)
- FastStone: [공식 기능 페이지](https://www.faststone.org/FSViewerDetail.htm), [BetaNews 7.6 (평점 시스템)](https://betanews.com/article/faststone-image-viewer-7-6/), [AlternativeTo](https://alternativeto.net/software/faststone-image-viewer/about)
- digiKam: [공식 기능 페이지](https://www.digikam.org/about/features/), [KDE 앱 페이지](https://apps.kde.org/cs/digikam/)
- Adobe Bridge: [동적 미디어 미리보기 (공식 문서)](https://helpx.adobe.com/bridge/using/preview-dynamic-media-files-adobe.html), [Adobe 블로그 2020](https://blog.adobe.com/en/publish/2020/10/20/adobe-bridge-levels-up-workflows-with-premiere-pro)
- Eagle: [공식 블로그 리뷰](https://www.eagle.cool/blog/post/how-to-organize-media-library), [AlternativeTo](https://alternativeto.net/software/eagle-cool/about)
- HandBrake: [Previewing your settings 1.9.0 (공식 문서)](https://handbrake.fr/docs/en/1.9.0/workflow/preview-settings.html)
- VLC 탐색바 썸네일: [VideoLAN 포럼](https://forum.videolan.org/viewtopic.php?p=339872), [VideoLAN 포럼 2021](https://forum.videolan.org/viewtopic.php?p=513596)
- Chromium HEVC 하드웨어 디코딩: [StaZhu/enable-chromium-hevc-hardware-decoding](https://fr.github.com/StaZhu/enable-chromium-hevc-hardware-decoding) (커뮤니티 자료)

제작사 공식 페이지(xnview.com, digikam.org, eagle.cool, helpx.adobe.com, handbrake.fr)는 이 환경의 네트워크 정책으로 직접 열지 못했다. 위 표의 A 등급은 검색 결과에 인용된 공식 문서 문장을 근거로 한다.
