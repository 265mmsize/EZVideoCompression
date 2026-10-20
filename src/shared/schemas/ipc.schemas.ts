/**
 * IPC 요청 검증 스키마 (zod).
 *
 * 메인 프로세스는 렌더러가 보낸 모든 요청을 이 스키마로 검증한 뒤 처리한다.
 * 렌더러는 신뢰할 수 없는 영역이므로 타입 선언만으로는 충분하지 않다.
 */
import { z } from 'zod';
import { COMPRESSION_MODES, OUTPUT_CONTAINERS, PRESETS, VIDEO_CODECS } from '../types/domain';
import type { InvokeChannel } from '../contracts/ipc';

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  // 널 문자는 경로에 올 수 없고, 인자 주입에 악용될 수 있으므로 거부한다.
  .refine((p) => !p.includes('\0'), '경로에 널 문자가 포함될 수 없습니다');

const idSchema = z.string().regex(/^[0-9a-f-]{36}$/, '작업 ID 형식이 올바르지 않습니다');

export const jobSettingsSchema = z.object({
  mode: z.enum(COMPRESSION_MODES),
  preset: z.enum(PRESETS),
  container: z.enum(OUTPUT_CONTAINERS),
  codec: z.enum(VIDEO_CODECS),
  targetMiB: z.number().positive().max(1_000_000).nullable(),
  videoStreamIndex: z.number().int().min(0).max(1000).nullable(),
});

export const appSettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  ffmpegPath: absolutePath.nullable(),
  ffprobePath: absolutePath.nullable(),
  defaults: jobSettingsSchema,
  keepLargerResults: z.boolean(),
  includeSubfoldersDefault: z.boolean(),
  outputFolderMode: z.enum(['same', 'custom']),
  customOutputDir: absolutePath.nullable(),
  outputSuffix: z
    .string()
    .min(1)
    .max(40)
    // 파일명에 쓸 수 없는 문자와 경로 구분자를 금지한다.
    .regex(/^[^\\/:*?"<>|\0]+$/, '접미사에 사용할 수 없는 문자가 있습니다'),
});

const voidSchema = z.undefined().or(z.null()).optional();

/** 채널별 요청 스키마. InvokeContract 와 1:1 로 대응해야 한다. */
export const invokeSchemas: Record<InvokeChannel, z.ZodType> = {
  'app:info': voidSchema,
  'tools:status': voidSchema,
  'tools:recheck': voidSchema,
  'settings:get': voidSchema,
  'settings:update': appSettingsSchema.partial(),
  'jobs:pickFiles': voidSchema,
  'jobs:pickFolder': z.object({ includeSubfolders: z.boolean() }),
  'jobs:addPaths': z.object({
    paths: z.array(absolutePath).max(5000),
    includeSubfolders: z.boolean(),
  }),
  'jobs:list': voidSchema,
  'jobs:updateSettings': z.object({ id: idSchema, settings: jobSettingsSchema.partial() }),
  'jobs:move': z.object({ id: idSchema, direction: z.enum(['up', 'down']) }),
  'jobs:start': z.object({ ids: z.array(idSchema).max(5000).nullable() }),
  'jobs:unqueue': z.object({ id: idSchema }),
  'jobs:cancel': z.object({ id: idSchema }),
  'jobs:retry': z.object({ id: idSchema }),
  'jobs:remove': z.object({ id: idSchema }),
  'queue:state': voidSchema,
  'queue:setPaused': z.object({ paused: z.boolean() }),
  'history:list': z.object({
    limit: z.number().int().min(1).max(500),
    offset: z.number().int().min(0),
  }),
  'shell:showInFolder': z.object({ path: absolutePath }),
  'logs:export': z.object({ maskPaths: z.boolean() }),
};
