/**
 * 오류 코드 카탈로그.
 *
 * 메인 프로세스는 오류를 코드로만 던지고, 사용자에게 보이는 문구(제목·원인·해결 방법)는
 * 이 카탈로그에서 가져온다. 그래야 UI 와 로그가 같은 용어를 쓰고, 테스트에서 코드로 검증할 수 있다.
 */

export const ERROR_CODES = [
  'TOOL_NOT_FOUND',
  'TOOL_VERSION_UNSUPPORTED',
  'INVALID_REQUEST',
  'INVALID_STATE',
  'INPUT_MISSING',
  'INPUT_CHANGED',
  'INPUT_UNREADABLE',
  'PROBE_FAILED',
  'PROBE_TIMEOUT',
  'UNSUPPORTED_INPUT',
  'UNSUPPORTED_SETTINGS',
  'OUTPUT_PATH_CONFLICT',
  'DISK_SPACE_LOW',
  'ENCODE_FAILED',
  'ENCODE_STALLED',
  'VALIDATION_FAILED',
  'TARGET_EXCEEDED',
  'CANCELLED',
  'INTERRUPTED',
  'SAMPLE_TIMEOUT',
  'LIBRARY_ROOT_INVALID',
  'MEDIA_NOT_FOUND',
  'PREVIEW_FAILED',
  'UNKNOWN',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorInfo {
  title: string;
  /** 무엇이 잘못되었는지 */
  cause: string;
  /** 사용자가 무엇을 하면 되는지 */
  action: string;
}

export const ERROR_CATALOG: Readonly<Record<ErrorCode, ErrorInfo>> = {
  TOOL_NOT_FOUND: {
    title: 'FFmpeg 를 찾을 수 없습니다',
    cause: '번들된 ffmpeg/ffprobe 도 없고, 시스템 PATH 에서도 실행 파일을 찾지 못했습니다.',
    action: '설정에서 ffmpeg·ffprobe 경로를 직접 지정하거나 앱을 다시 설치하세요.',
  },
  TOOL_VERSION_UNSUPPORTED: {
    title: 'FFmpeg 버전이 지원 범위를 벗어납니다',
    cause: '실행 파일은 있지만 필요한 옵션(-progress, -fps_mode 등)을 지원하지 않습니다.',
    action: 'FFmpeg 5.1 이상 버전을 설치하거나 설정에서 다른 경로를 지정하세요.',
  },
  INVALID_REQUEST: {
    title: '잘못된 요청입니다',
    cause: '요청 값이 허용된 형식이 아닙니다.',
    action: '입력값을 확인하고 다시 시도하세요.',
  },
  INVALID_STATE: {
    title: '현재 상태에서 수행할 수 없는 작업입니다',
    cause: '작업의 현재 상태가 요청한 동작을 허용하지 않습니다.',
    action: '작업 상태를 확인한 뒤 다시 시도하세요.',
  },
  INPUT_MISSING: {
    title: '원본 파일이 없습니다',
    cause: '등록 이후 파일이 이동되었거나 삭제되었습니다.',
    action: '파일을 되돌려 놓거나 목록에서 제거한 뒤 다시 추가하세요.',
  },
  INPUT_CHANGED: {
    title: '원본 파일이 변경되었습니다',
    cause: '분석한 뒤 파일 크기 또는 수정 시간이 바뀌었습니다.',
    action: '작업을 재시도하여 다시 분석하세요.',
  },
  INPUT_UNREADABLE: {
    title: '원본 파일을 읽을 수 없습니다',
    cause: '권한 문제이거나 다른 프로그램이 파일을 사용 중입니다.',
    action: '파일 권한과 사용 중인 프로그램을 확인한 뒤 재시도하세요.',
  },
  PROBE_FAILED: {
    title: '영상 정보를 분석하지 못했습니다',
    cause: 'ffprobe 가 파일을 영상으로 인식하지 못했거나 파일이 손상되었습니다.',
    action: '원본을 다른 플레이어에서 재생해 보고, 손상된 파일이면 다시 받으세요.',
  },
  PROBE_TIMEOUT: {
    title: '영상 분석 시간이 초과되었습니다',
    cause: '파일이 매우 크거나 네트워크 드라이브에 있어 응답이 늦습니다.',
    action: '파일을 로컬 디스크로 옮긴 뒤 재시도하세요.',
  },
  UNSUPPORTED_INPUT: {
    title: '현재 버전에서 처리할 수 없는 형식입니다',
    cause:
      '이 영상의 특성(HDR, Dolby Vision, 알파 채널, 인터레이스 등)은 재인코딩 경로가 검증되지 않았습니다.',
    action: '원본 유지 모드를 사용하거나 해당 특성이 없는 파일로 처리하세요.',
  },
  UNSUPPORTED_SETTINGS: {
    title: '선택한 설정으로는 처리할 수 없습니다',
    cause: '입력 특성과 출력 코덱·컨테이너 조합이 호환되지 않습니다.',
    action: '출력 코덱을 바꾸거나 설정 안내에 따라 조정하세요.',
  },
  OUTPUT_PATH_CONFLICT: {
    title: '출력 경로가 원본과 충돌합니다',
    cause: '출력 파일이 원본과 같은 경로이거나 다른 작업의 원본입니다.',
    action: '출력 폴더 또는 접미사를 변경하세요.',
  },
  DISK_SPACE_LOW: {
    title: '디스크 여유 공간이 부족합니다',
    cause: '출력 폴더의 여유 공간이 예상 용량과 안전 여유분을 감당하지 못합니다.',
    action: '출력 폴더의 공간을 확보하거나 다른 드라이브를 지정하세요.',
  },
  ENCODE_FAILED: {
    title: '인코딩에 실패했습니다',
    cause: 'FFmpeg 가 비정상 종료했습니다. 상세 로그에 마지막 오류 출력이 있습니다.',
    action: '상세 로그를 확인하고, 원인이 해결되면 재시도하세요.',
  },
  ENCODE_STALLED: {
    title: '인코딩 진행이 멈춘 것으로 판단했습니다',
    cause: '일정 시간 동안 진행 정보가 갱신되지 않았습니다.',
    action: '시스템 부하를 줄이고 재시도하세요.',
  },
  VALIDATION_FAILED: {
    title: '결과 검증에 실패했습니다',
    cause:
      '출력 파일이 기대한 구조·길이·디코딩 조건을 만족하지 않습니다. 결과는 확정되지 않았습니다.',
    action: '검증 항목을 확인하세요. 원본은 변경되지 않았습니다.',
  },
  TARGET_EXCEEDED: {
    title: '목표 용량을 초과했습니다',
    cause: '자동 재시도 한도 안에서도 결과가 목표 용량 이하가 되지 않았습니다.',
    action: '목표 용량을 높이거나 고품질 자동 모드를 사용하세요.',
  },
  CANCELLED: {
    title: '사용자가 작업을 취소했습니다',
    cause: '현재 작업이 사용자 요청으로 중단되었습니다.',
    action: '필요하면 재시도하세요. 원본은 변경되지 않았습니다.',
  },
  INTERRUPTED: {
    title: '앱 종료로 작업이 중단되었습니다',
    cause: '인코딩 중 앱이 종료되었거나 비정상 종료되었습니다.',
    action: '재시도하면 처음부터 다시 처리합니다. 중간 지점 재개는 지원하지 않습니다.',
  },
  SAMPLE_TIMEOUT: {
    title: '샘플 품질 추천 시간이 초과되었습니다',
    cause: '샘플 구간 인코딩과 측정이 제한 시간(2분)을 넘었습니다.',
    action: '추천 없이 기본 설정으로 진행하거나 다시 시도하세요.',
  },
  LIBRARY_ROOT_INVALID: {
    title: '폴더를 등록할 수 없습니다',
    cause: '경로가 폴더가 아니거나, 이미 등록된 폴더 안에 있거나, 읽을 수 없습니다.',
    action: '다른 폴더를 선택하거나 기존 등록을 먼저 해제하세요.',
  },
  MEDIA_NOT_FOUND: {
    title: '미디어 항목을 찾을 수 없습니다',
    cause: '라이브러리에서 제거되었거나 파일이 이동·삭제되었습니다.',
    action: '폴더를 다시 인덱싱하거나 목록을 새로 고치세요.',
  },
  PREVIEW_FAILED: {
    title: '미리보기를 만들지 못했습니다',
    cause: 'FFmpeg 가 프레임 추출 또는 변환본 생성에 실패했습니다.',
    action: '상세 로그를 확인하세요. 원본 파일은 변경되지 않았습니다.',
  },
  UNKNOWN: {
    title: '알 수 없는 오류가 발생했습니다',
    cause: '예상하지 못한 내부 오류입니다.',
    action: '로그를 내보내 지원팀에 전달하세요.',
  },
};

/** 렌더러와 메인이 주고받는 오류 응답 형태 */
export interface AppErrorPayload {
  code: ErrorCode;
  /** 기술 상세 (화면에서는 접어서 보여준다) */
  detail: string | null;
}
