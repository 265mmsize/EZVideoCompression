# 계획: 미디어 라이브러리(파일 관리)와 재생 미리보기

작성일: 2026-10-27. 근거: `docs/BENCHMARK_MEDIA_MANAGEMENT.md`.
이 문서는 구현 전 계획이다. 각 단계는 실제로 동작한 뒤 다음 단계로 넘어가며, 상태는 `docs/IMPLEMENTATION_STATUS.md` 에 기록한다.

## 1. 목표와 원칙

목표: 사용자가 영상·이미지 폴더를 앱 안에서 훑어보고(썸네일, 필터, 평점·태그), 파일을 바로 미리보기·재생하며,
압축 대상을 고르고 결과를 원본과 비교할 수 있게 한다.

지키는 원칙 (기존 제품 원칙의 연장)

1. **원본 비파괴**: 파일 이동·삭제·이름 바꾸기·메타데이터 쓰기를 하지 않는다. 평점·태그·라벨은 앱 DB 에만 저장한다.
2. **오프라인**: 외부 서버에 파일·경로·썸네일을 보내지 않는다.
3. **정직한 표시**: 미리보기 프록시(재인코딩본)는 "미리보기용 변환본"으로 표시하고 압축 결과로 오인하지 않게 한다. 썸네일 생성·인덱싱은 진행률과 실패 사유를 보여준다.
4. **보안 경계 유지**: 렌더러는 여전히 파일 시스템에 직접 접근하지 않는다. 미디어는 메인이 **허용 목록에 있는 경로만** 전용 프로토콜로 제공한다.
5. **압축 작업을 방해하지 않음**: 썸네일·프록시 생성은 인코딩보다 낮은 우선순위로, 인코딩 중에는 동시 1개로 제한한다.

범위 밖: EXIF/XMP 편집, 얼굴 인식, 지도, 클라우드, 지각 해시 유사도, 자막 렌더링·배속 같은 플레이어 기능.

## 2. 사용자 흐름

1. "라이브러리" 탭에서 폴더를 등록한다(여러 개, 하위 폴더 포함 선택). 등록 즉시 백그라운드 인덱싱이 시작되고 진행률이 보인다.
2. 왼쪽 폴더 트리, 가운데 썸네일 그리드(또는 리스트), 오른쪽 상세·미리보기 패널.
3. 그리드에서 영상 썸네일 위에 마우스를 올리면 가로 위치에 따라 시점이 바뀐다(스크럽). 클릭하면 상세 패널에서 재생한다.
4. 필터(종류, 날짜, 크기, 해상도, 코덱, 평점, 라벨, 태그, "아직 압축 안 함")와 정렬로 대상을 좁힌다.
5. 선택한 파일을 "압축 대기열에 추가"하면 기존 작업 목록으로 넘어간다. 압축이 끝난 파일은 라이브러리에서 원본·결과 쌍으로 보이고, 비교 화면에서 같은 시점으로 나란히 본다.
6. "설정 미리보기"로 현재 압축 설정(또는 샘플 추천 후보)을 짧은 구간에 적용해 원본과 비교한다.

## 3. 아키텍처 변경

### 3.1 미디어 제공 프로토콜 (`vslim-media://`)

현재 렌더러 CSP 는 `default-src 'none'; img-src 'self' data: blob:` 이고 `media-src` 가 없다. 로컬 파일을 `<img>`·`<video>` 로 열려면 메인이 제공하는 전용 프로토콜이 필요하다.

- `protocol.registerSchemesAsPrivileged([{ scheme: 'vslim-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: false } }])` 를 `app.whenReady()` 전에 등록한다. `stream: true` 가 있어야 `<video>` 의 Range 요청(탐색)이 동작한다.
- `protocol.handle('vslim-media', …)` 는 URL 의 토큰을 **메인이 발급한 허용 목록**(라이브러리 항목 ID, 썸네일 ID, 프록시 ID)으로만 해석한다. 경로를 URL 에 싣지 않는다. 등록되지 않은 토큰은 404.
- Range 헤더를 지원해 부분 응답(206)을 돌려준다 (큰 파일 탐색 성능).
- CSP 에 `img-src vslim-media:` 와 `media-src vslim-media:` 를 추가한다. `webRequest.onBeforeRequest` 허용 목록에도 이 스킴을 더한다.

### 3.2 새 모듈 (`src/main/services/library/`)

| 모듈                     | 책임                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LibraryRootService`     | 등록 폴더 관리, 폴더 트리 열거(심볼릭 링크 제외, 숨김 파일 제외, 상한 5만 파일)                                                                                                                                |
| `LibraryIndexer`         | 백그라운드 인덱싱: stat → (영상) ffprobe / (이미지) ffprobe 로 해상도·포맷 → DB 저장. 변경 감지(크기·mtime), 삭제된 파일 표시. 직렬 큐, 취소 가능                                                              |
| `ThumbnailService`       | 썸네일 생성·캐시: 영상은 N 개 시점(기본 10, 길이에 따라 조정) 의 JPEG 스트립, 이미지는 축소 JPEG. 캐시 키 = 경로 정규화 + 크기 + mtime. 캐시 디렉터리 `userData/thumbs/<2자리>/<해시>.jpg`, 상한 용량 LRU 정리 |
| `PreviewService`         | 재생 가능성 판정(ffprobe 코덱 + 렌더러 `canPlayType` 결과를 메인에 보고), 프레임 추출(정확한 시점, `-ss` 정밀 탐색), 미리보기 프록시 생성(H.264 720p, CRF 28, 최대 길이·용량 상한, 취소 가능, "변환본" 표시)   |
| `SettingsPreviewService` | HandBrake 방식: 지정 시점에서 N 초를 현재 설정으로 실제 인코딩 → 원본 프록시와 함께 제공. 3단계 `SampleEncodeService` 의 구간 인코딩 재사용                                                                    |
| `MediaTokenRegistry`     | 프로토콜 토큰 ↔ 실제 파일 경로 매핑, 만료, 허용 목록                                                                                                                                                           |
| `LibraryRepository`      | DB 접근                                                                                                                                                                                                        |

기존 `JobQueueService` 는 그대로 두고, 라이브러리에서 "대기열에 추가"는 `addPaths` 를 호출한다.

### 3.3 DB (마이그레이션 3)

```
library_roots(id, path, path_key, include_subfolders, added_at, last_indexed_at, status)
library_items(id, root_id, path, path_key, parent_dir_key, file_name, kind['video'|'image'|'other'],
              size_bytes, mtime_ms, probe_json, width, height, duration_sec, codec, container,
              indexed_at, missing INTEGER, error_code)
library_meta(item_key PRIMARY KEY, rating INTEGER, label TEXT, note TEXT)   -- 파일이 다시 인덱싱되어도 유지되도록 경로 키 기준
library_tags(id, name UNIQUE)
library_item_tags(item_key, tag_id, PRIMARY KEY(item_key, tag_id))
thumbnails(cache_key PRIMARY KEY, file, bytes, created_at, last_used_at)
previews(id, item_key, kind['proxy'|'settings'], file, settings_json, created_at, last_used_at)
```

인덱스: `library_items(root_id)`, `(parent_dir_key)`, `(kind)`, `(path_key)`. `jobs.input_path_key` 와 조인해 "압축 결과" 를 연결한다.

### 3.4 IPC (계약·스키마·핸들러 세 곳에 함께 추가)

`library:roots.list/add/remove`, `library:tree`, `library:items.query`(필터·정렬·페이지), `library:item.get`,
`library:meta.set`(평점·라벨·메모), `library:tags.list/add/remove`, `library:thumb.url`, `library:scrub.urls`,
`library:preview.capability`, `library:preview.frame`, `library:preview.proxy.create/cancel`,
`library:preview.settings.create/cancel`, `library:enqueueCompression`, `library:duplicates`.
이벤트: `library:indexing`(진행률), `library:item.changed`, `library:preview.progress`.

### 3.5 렌더러

- 탭 "라이브러리" 추가. 페이지 `LibraryPage` (폴더 트리 / 그리드·리스트 / 상세·미리보기 3분할, 키보드 탐색 가능).
- 컴포넌트: `FolderTree`, `MediaGrid`(가상 스크롤: 1만 항목 이상 대비, 외부 라이브러리 없이 직접 구현), `MediaCard`(썸네일 + 스크럽), `FilterBar`, `MediaDetail`, `MediaPlayer`(`<video>` + 직접 재생 불가 시 프레임 뷰어 + "프록시 만들기" 버튼), `ComparePane`(원본·결과 동기화, 슬라이더·토글·확대).
- 기존 "비교" 탭의 미구현 안내를 실제 비교 화면으로 교체한다.
- 큰 목록 성능: 썸네일은 보이는 범위만 요청, 요청 취소, 캐시 적중 시 즉시 표시.

## 4. 단계별 구현 (각 단계 끝에 테스트와 상태 보고)

### L1. 미디어 제공 기반 + 이미지·영상 썸네일 (기반)

- 전용 프로토콜, 토큰 레지스트리, CSP 변경, Range 응답
- `LibraryRootService`, `LibraryIndexer`(직렬, 진행률, 취소), DB 마이그레이션 3
- `ThumbnailService`(영상 1장 + 이미지), 캐시와 LRU 정리
- 라이브러리 페이지 최소 버전: 폴더 등록, 트리, 그리드, 상세(ffprobe 정보)
- 테스트: 토큰 외 경로 거부, Range 206, 썸네일 캐시 키, 인덱서 변경 감지, 심볼릭 링크 제외, 한글 경로

### L2. 재생 미리보기

- 재생 가능성 판정(코덱·컨테이너·음성 코덱), 직접 재생, 프레임 추출 뷰어, 프록시 생성(상한·취소·"변환본" 표시)
- 영상 스크럽 스트립(N 시점), 마우스 위치에 따른 시점 표시
- 테스트: H.264 직접 재생 판정, HEVC 는 프록시 경로, AC-3 음성은 "무음 재생 또는 프록시" 안내, 프록시 생성 취소 시 임시 파일 없음

### L3. 관리 기능

- 평점·라벨·태그·메모(앱 DB), 필터·정렬·검색, 리스트/그리드 전환, 다중 선택, "대기열에 추가", 압축 결과 연결 표시
- 중복 후보: 같은 크기+길이 → 선택 시 SHA-256 비교 (전체 해시는 사용자가 요청할 때만)
- 테스트: 필터 조합 쿼리, 재인덱싱 후 평점 유지, 삭제된 파일 표시와 복구

### L4. 비교와 설정 미리보기

- 원본·결과 비교 화면(동기화 시점, 토글, 슬라이더, 확대), 샘플 지표 표시
- 설정 미리보기(HandBrake 방식): 시점·길이 지정 → 현재 설정으로 인코딩 → 나란히 재생
- 테스트: 동일 시점 프레임 추출 일치, 설정 미리보기 결과가 압축 결과로 저장되지 않음

### L5. 안정화·배포

- 대량 폴더(1만+ 파일) 인덱싱 시간과 메모리 측정, 가상 스크롤 검증
- 캐시 용량 설정, 캐시 비우기, 라이브러리 제거 시 캐시 정리
- 문서·릴리스 노트·테스트 보고서 갱신, 1.1.0 패키징

예상 규모: 메인 약 2,500줄, 렌더러 약 2,000줄, 테스트 약 1,200줄. 단계마다 커밋·푸시한다.

## 5. 위험과 대응

| 위험                                                 | 대응                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| HEVC 가 Windows 에서 장치에 따라 재생되거나 안 됨    | `canPlayType` 결과를 믿지 않고 실제 `<video>` 오류 이벤트에서 프레임 뷰어로 즉시 대체 |
| MKV 직접 재생이 "maybe"                              | MKV 는 기본적으로 프레임 추출 경로, 사용자가 "직접 재생 시도" 선택 가능               |
| HEIC/RAW 이미지를 번들 FFmpeg 도 Chromium 도 못 읽음 | 종류 'other' 로 표시하고 썸네일 없이 목록에 둠. 지원 형식 문서에 명시                 |
| 대량 썸네일 생성이 인코딩을 느리게 함                | 인코딩 중 썸네일 동시 1개, 유휴 시 2개. 우선순위: 보이는 항목 먼저                    |
| 캐시가 디스크를 채움                                 | 기본 상한 2 GiB, LRU 정리, 설정에서 변경                                              |
| 프로토콜 핸들러로 임의 파일 노출                     | 경로가 아닌 토큰만 허용, 토큰은 라이브러리·작업에 등록된 파일에만 발급                |

## 6. 결정이 필요한 항목

1. **범위**: L1~L5 전체를 진행할지, L1~L2(미리보기 중심)까지 먼저 할지.
2. **이미지 범위**: JPEG/PNG/WebP/GIF/BMP/TIFF/AVIF 까지(번들 FFmpeg 로 처리 가능)로 할지, HEIC 를 위해 별도 디코더(libheif 포함 FFmpeg 빌드 교체)를 검토할지.
3. **평점·태그 저장 위치**: 앱 DB 만(권장, 원본 비파괴) vs 파일 옆 사이드카(.xmp) 추가 제공.
4. **중복 찾기 수준**: 크기·길이·해시(권장, 범위 안) vs 지각 해시 유사도(별도 단계).
