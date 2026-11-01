/**
 * 재생목록 저장소. 이 PC의 브라우저 저장소에 둔다 (사용자 편의 설정). 잘못된 값은 버린다.
 */
export interface Playlist {
  id: string;
  name: string;
  itemIds: string[];
}

export const PLAYLISTS_KEY = 'vslim.playlists';

export function parsePlaylists(raw: string | null): Playlist[] {
  if (raw === null) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    const out: Playlist[] = [];
    for (const p of v) {
      if (typeof p !== 'object' || p === null) continue;
      const r = p as Record<string, unknown>;
      if (
        typeof r['id'] !== 'string' ||
        typeof r['name'] !== 'string' ||
        !Array.isArray(r['itemIds'])
      )
        continue;
      const itemIds = r['itemIds'].filter((x): x is string => typeof x === 'string');
      out.push({ id: r['id'], name: r['name'].slice(0, 80), itemIds });
    }
    return out;
  } catch {
    return [];
  }
}

export function loadPlaylists(): Playlist[] {
  try {
    return parsePlaylists(localStorage.getItem(PLAYLISTS_KEY));
  } catch {
    return [];
  }
}

export function savePlaylists(lists: Playlist[]): void {
  try {
    localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(lists));
  } catch {
    // 저장소를 못 써도 목록은 이번 화면에서만 유효하다
  }
}

export function newPlaylist(name: string): Playlist {
  return { id: crypto.randomUUID(), name: name.trim() || '새 재생목록', itemIds: [] };
}
