/** 유튜브 임베드: 주소 해석, 임베드 주소, 플레이어 메시지, 네트워크 정책, 렌더러 CSP */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { embedUrl, parseStart, parseYouTubeUrl } from '../../src/renderer/youtube/youtubeUrl';
import { currentTimeFromMessage, playerCommand } from '../../src/renderer/youtube/playerMessages';
import {
  EMBED_REFERER,
  isYouTubeHost,
  isYouTubeRequestAllowed,
} from '../../src/main/services/youtube/youtubePolicy';

const ID = 'dQw4w9WgXcQ';

describe('유튜브 주소 해석', () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&list=PL123`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `www.youtube.com/watch?v=${ID}`,
  ])('영상 ID 를 꺼낸다: %s', (url) => {
    expect(parseYouTubeUrl(url)?.videoId).toBe(ID);
  });

  it('시작 위치 t 를 읽는다 (초, 1m30s 형식)', () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=90`)?.startSec).toBe(90);
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&t=1m30s`)?.startSec).toBe(90);
  });

  it.each([
    '',
    '   ',
    'http://www.youtube.com/watch?v=' + ID,
    `https://example.com/watch?v=${ID}`,
    `https://youtube.com.evil.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=short`,
    'https://www.youtube.com/watch',
    'https://music.youtube.com/watch?v=' + ID,
    'not a url',
  ])('받지 않는 주소는 null: %s', (url) => {
    expect(parseYouTubeUrl(url)).toBeNull();
  });

  it('임베드 주소는 유튜브 전용 도메인과 검증된 ID 만 쓴다', () => {
    const url = embedUrl({ videoId: ID, startSec: 12 });
    expect(url.startsWith('https://www.youtube-nocookie.com/embed/' + ID + '?')).toBe(true);
    expect(url).toContain('enablejsapi=1');
    expect(url).toContain('start=12');
  });

  it('잘못된 시작 위치는 0 으로 본다', () => {
    expect(parseStart(null)).toBe(0);
    expect(parseStart('abc')).toBe(0);
    expect(parseStart('1h2m3s')).toBe(3723);
  });
});

describe('플레이어 메시지', () => {
  it('명령은 JSON 문자열이다', () => {
    expect(JSON.parse(playerCommand('seekTo', [30, true]))).toEqual({
      event: 'command',
      func: 'seekTo',
      args: [30, true],
    });
  });

  it('현재 재생 시각은 infoDelivery 메시지에서만 읽는다', () => {
    const ok = JSON.stringify({ event: 'infoDelivery', info: { currentTime: 12.5 } });
    expect(currentTimeFromMessage(ok)).toBe(12.5);
    expect(currentTimeFromMessage({ event: 'infoDelivery', info: { currentTime: 3 } })).toBe(3);
    expect(currentTimeFromMessage(JSON.stringify({ event: 'onReady' }))).toBeNull();
    expect(currentTimeFromMessage('not json')).toBeNull();
    expect(currentTimeFromMessage({ event: 'infoDelivery', info: { currentTime: -1 } })).toBeNull();
  });
});

describe('네트워크 정책 (기본 꺼짐)', () => {
  const player = `https://www.youtube-nocookie.com/embed/${ID}`;

  it('유튜브 호스트 판정은 정확한 도메인과 하위 도메인만 본다', () => {
    expect(isYouTubeHost('www.youtube-nocookie.com')).toBe(true);
    expect(isYouTubeHost('r3---sn-abc.googlevideo.com')).toBe(true);
    expect(isYouTubeHost('i.ytimg.com')).toBe(true);
    expect(isYouTubeHost('youtube.com.evil.com')).toBe(false);
    expect(isYouTubeHost('notyoutube.com')).toBe(false);
  });

  it('설정을 끄면 유튜브 요청도 막는다', () => {
    expect(isYouTubeRequestAllowed(player, false)).toBe(false);
  });

  it('설정을 켜면 https 유튜브 요청만 허용한다', () => {
    expect(isYouTubeRequestAllowed(player, true)).toBe(true);
    expect(isYouTubeRequestAllowed(`http://www.youtube.com/`, true)).toBe(false);
    expect(isYouTubeRequestAllowed('https://example.com/', true)).toBe(false);
    expect(isYouTubeRequestAllowed('https://youtube.com.evil.com/', true)).toBe(false);
    expect(isYouTubeRequestAllowed('not a url', true)).toBe(false);
  });

  it('Referer 는 앱 식별용 주소다', () => {
    expect(EMBED_REFERER.startsWith('https://')).toBe(true);
  });

  it('렌더러 CSP 는 유튜브 프레임만 열고 네트워크 연결은 막은 채로 둔다', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    expect(html).toContain('frame-src https://www.youtube-nocookie.com');
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("script-src 'self'");
  });
});
