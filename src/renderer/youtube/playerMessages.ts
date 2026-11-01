/**
 * 유튜브 플레이어와 주고받는 postMessage 형식 (순수 함수).
 * 명령은 JSON 문자열로 보내고, 현재 재생 시각은 infoDelivery 메시지에서 읽는다.
 */

export type PlayerFunc = 'playVideo' | 'pauseVideo' | 'seekTo';

/** 플레이어에게 명령을 보내는 메시지 */
export function playerCommand(func: PlayerFunc, args: unknown[] = []): string {
  return JSON.stringify({ event: 'command', func, args });
}

/** 플레이어가 정보를 보내도록 청취를 요청하는 메시지 */
export const LISTENING_MESSAGE = JSON.stringify({ event: 'listening', channel: 'widget' });

/** 플레이어 메시지에서 현재 재생 시각(초)을 꺼낸다. 관계없는 메시지는 null. */
export function currentTimeFromMessage(data: unknown): number | null {
  let v: unknown = data;
  if (typeof data === 'string') {
    try {
      v = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object') return null;
  const rec = v as { event?: unknown; info?: { currentTime?: unknown } };
  if (rec.event !== 'infoDelivery') return null;
  const t = rec.info?.currentTime;
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : null;
}
