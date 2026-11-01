/**
 * 유튜브 임베드 재생을 위한 네트워크 정책 (순수 함수).
 * 설정에서 "유튜브 임베드 재생"을 켠 경우에만 유튜브 호스트 요청을 허용한다. 기본은 꺼짐.
 */

/** 플레이어가 쓰는 호스트 (임베드 페이지, 스트리밍, 썸네일과 플레이어 자원). 목록에 없는 호스트는 항상 막는다. */
const YOUTUBE_DOMAINS = [
  'youtube-nocookie.com',
  'youtube.com',
  'ytimg.com',
  'googlevideo.com',
  'gstatic.com',
  'google.com',
  'googleapis.com',
] as const;

/**
 * 플레이어 요청에 붙이는 Referer. file:// 로 연 앱은 Referer 가 없어서
 * 플레이어가 임베드 재생을 거부(오류 153)하므로 앱 식별용 주소를 붙인다.
 */
export const EMBED_REFERER = 'https://vslim-desktop.local/';

export function isYouTubeHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return YOUTUBE_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** https 이고 유튜브 호스트인 요청인지 (설정과 무관) */
export function isYouTubeRequest(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && isYouTubeHost(u.hostname);
}

/** 유튜브 요청은 임베드 설정이 켜져 있을 때만 허용 */
export function isYouTubeRequestAllowed(url: string, embedEnabled: boolean): boolean {
  return embedEnabled && isYouTubeRequest(url);
}
