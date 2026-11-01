/**
 * 킹뷰 보기 기능의 순수 로직: 쪽 배치, 웹툰 폭, 슬라이드쇼, 루페, 영역, 재생목록
 */
import { describe, expect, it } from 'vitest';
import {
  addToPlaylist,
  buildSpreads,
  clampIndex,
  loupeBackground,
  movePlaylistItem,
  nextWebtoonWidth,
  regionFromDrag,
  removeFromPlaylist,
  slideshowNext,
  spreadIndexOf,
  stepIndex,
} from '../../src/renderer/viewer/viewerMath';
import { newPlaylist, parsePlaylists } from '../../src/renderer/viewer/playlistStore';

describe('2장 보기 쪽 배치', () => {
  it('1장씩 보기는 장마다 한 쪽', () => {
    expect(buildSpreads(3, { twoUp: false, coverSingle: false, rtl: false })).toEqual([
      [0],
      [1],
      [2],
    ]);
  });

  it('2장씩 보기는 왼쪽에서 오른쪽, 표지 단독과 일본식 순서를 지원한다', () => {
    expect(buildSpreads(5, { twoUp: true, coverSingle: false, rtl: false })).toEqual([
      [0, 1],
      [2, 3],
      [4],
    ]);
    expect(buildSpreads(5, { twoUp: true, coverSingle: true, rtl: false })).toEqual([
      [0],
      [1, 2],
      [3, 4],
    ]);
    // 일본식: 펼친 쪽의 오른쪽이 먼저 읽는 장이라 화면 순서가 뒤집힌다
    expect(buildSpreads(4, { twoUp: true, coverSingle: false, rtl: true })).toEqual([
      [1, 0],
      [3, 2],
    ]);
    expect(buildSpreads(0, { twoUp: true, coverSingle: true, rtl: true })).toEqual([]);
  });

  it('장 번호가 속한 쪽을 찾는다', () => {
    const spreads = buildSpreads(5, { twoUp: true, coverSingle: true, rtl: false });
    expect(spreadIndexOf(spreads, 0)).toBe(0);
    expect(spreadIndexOf(spreads, 3)).toBe(2);
  });
});

describe('웹툰·슬라이드쇼·이동', () => {
  it('웹툰 폭은 100%, 640, 760, 800 을 돈다', () => {
    expect(nextWebtoonWidth(0)).toBe(640);
    expect(nextWebtoonWidth(800)).toBe(0);
  });

  it('슬라이드쇼는 끝에서 처음으로 돌고, 이동은 범위 안에서 멈춘다', () => {
    expect(slideshowNext(2, 3)).toBe(0);
    expect(slideshowNext(0, 0)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(0);
    expect(stepIndex(2, 3, 1)).toBe(2);
    expect(clampIndex(9, 3)).toBe(2);
  });
});

describe('루페와 영역', () => {
  it('루페 배경은 커서 아래 점을 돋보기 중심에 둔다', () => {
    // 상자 200x100, 원본 200x100 (맞춤 1배), 커서 (50, 40), 확대 4배, 반지름 60
    const bg = loupeBackground({
      cursorX: 50,
      cursorY: 40,
      boxW: 200,
      boxH: 100,
      natW: 200,
      natH: 100,
      zoom: 4,
      radius: 60,
    });
    expect(bg).toEqual({ bgW: 800, bgH: 400, posX: 60 - 200, posY: 60 - 160 });
    expect(
      loupeBackground({
        cursorX: 0,
        cursorY: 0,
        boxW: 0,
        boxH: 10,
        natW: 1,
        natH: 1,
        zoom: 2,
        radius: 5,
      }),
    ).toBeNull();
  });

  it('드래그 영역을 원본 픽셀 사각형으로 바꾸고, 너무 작으면 버린다', () => {
    const fit = { scale: 1, tx: 0, ty: 0 };
    // 상자 200x100, 원본 400x200 (맞춤 0.5배): 화면 (10,10)~(110,60) → 원본 (20,20)~(220,120)
    const r = regionFromDrag(10, 10, 110, 60, fit, 200, 100, 400, 200);
    expect(r).toEqual({ x: 20, y: 20, width: 201, height: 101 });
    expect(regionFromDrag(10, 10, 10, 10, fit, 200, 100, 400, 200)).toBeNull();
  });

  it('영역이 이미지 밖으로 나가면 가장자리에 맞춘다', () => {
    const fit = { scale: 1, tx: 0, ty: 0 };
    const r = regionFromDrag(0, 0, 199, 99, fit, 200, 100, 100, 50);
    expect(r && r.x + r.width).toBeLessThanOrEqual(100);
    expect(r && r.y + r.height).toBeLessThanOrEqual(50);
  });
});

describe('재생목록', () => {
  it('추가는 중복을 막고, 이동과 삭제는 범위 안에서만 한다', () => {
    let l = addToPlaylist([], 'a');
    l = addToPlaylist(l, 'b');
    l = addToPlaylist(l, 'a');
    expect(l).toEqual(['a', 'b']);
    expect(movePlaylistItem(l, 1, -1)).toEqual(['b', 'a']);
    expect(movePlaylistItem(l, 0, -1)).toEqual(['a', 'b']);
    expect(removeFromPlaylist(l, 0)).toEqual(['b']);
  });

  it('저장된 재생목록 JSON 은 잘못된 항목을 버리고 읽는다', () => {
    const raw = JSON.stringify([
      { id: '1', name: '여행', itemIds: ['x', 3, 'y'] },
      { id: 2, name: '깨짐', itemIds: [] },
      'junk',
    ]);
    expect(parsePlaylists(raw)).toEqual([{ id: '1', name: '여행', itemIds: ['x', 'y'] }]);
    expect(parsePlaylists('not json')).toEqual([]);
    expect(newPlaylist('  ').name).toBe('새 재생목록');
  });
});
