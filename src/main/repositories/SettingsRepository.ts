/**
 * 설정 저장소. 키-값 테이블에 JSON 으로 저장하고, 읽을 때 기본값과 병합한 뒤 스키마로 검증한다.
 * 손상된 값이 있어도 앱은 기본값으로 계속 동작한다 (잘못된 설정 때문에 실행이 막히면 안 된다).
 */
import type { AppSettings } from '../../shared/types/domain';
import { appSettingsSchema } from '../../shared/schemas/ipc.schemas';
import type { Db } from '../database/Database';

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  ffmpegPath: null,
  ffprobePath: null,
  defaults: {
    mode: 'quality',
    preset: 'compatibility',
    container: 'mp4',
    codec: 'h264',
    targetMiB: null,
    videoStreamIndex: null,
    crf: null,
    externalSubtitles: true,
  },
  keepLargerResults: false,
  fastUseHardware: true,
  includeSubfoldersDefault: false,
  outputFolderMode: 'same',
  customOutputDir: null,
  outputSuffix: '-slim',
  cacheLimitMiB: 2048,
};

const KEY = 'app';

export class SettingsRepository {
  constructor(private readonly db: Db) {}

  get(): AppSettings {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(KEY) as
      { value_json: string } | undefined;
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    try {
      const parsed: unknown = JSON.parse(row.value_json);
      const stored = parsed as Partial<AppSettings>;
      // 이전 버전에서 저장된 값은 새로 생긴 키가 없을 수 있으므로 기본값과 깊게 병합한다
      const merged = {
        ...DEFAULT_SETTINGS,
        ...stored,
        defaults: { ...DEFAULT_SETTINGS.defaults, ...stored.defaults },
      };
      const checked = appSettingsSchema.safeParse(merged);
      return checked.success ? checked.data : structuredClone(DEFAULT_SETTINGS);
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next = { ...this.get(), ...patch };
    const checked = appSettingsSchema.parse(next);
    this.db
      .prepare(
        `INSERT INTO settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(KEY, JSON.stringify(checked));
    return checked;
  }
}
