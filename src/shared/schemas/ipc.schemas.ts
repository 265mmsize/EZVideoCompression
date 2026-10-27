/**
 * IPC 요청 검증 스키마 (zod).
 *
 * 메인 프로세스는 렌더러가 보낸 모든 요청을 이 스키마로 검증한 뒤 처리한다.
 * 렌더러는 신뢰할 수 없는 영역이므로 타입 선언만으로는 충분하지 않다.
 */
import { z } from 'zod';
import {
  COMPRESSION_MODES,
  LIBRARY_SORTS,
  MEDIA_KINDS,
  MEDIA_LABELS,
  OUTPUT_CONTAINERS,
  PRESETS,
  VIDEO_CODECS,
} from '../types/domain';
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
  crf: z.number().int().min(10).max(40).nullable(),
  externalSubtitles: z.boolean(),
});

export const appSettingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  ffmpegPath: absolutePath.nullable(),
  ffprobePath: absolutePath.nullable(),
  defaults: jobSettingsSchema,
  keepLargerResults: z.boolean(),
  fastUseHardware: z.boolean(),
  includeSubfoldersDefault: z.boolean(),
  outputFolderMode: z.enum(['same', 'custom']),
  customOutputDir: absolutePath.nullable(),
  outputSuffix: z
    .string()
    .min(1)
    .max(40)
    // 파일명에 쓸 수 없는 문자와 경로 구분자를 금지한다.
    .regex(/^[^\\/:*?"<>|\0]+$/, '접미사에 사용할 수 없는 문자가 있습니다'),
  cacheLimitMiB: z.number().int().min(100).max(1_000_000),
});

const mediaRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('item'), id: idSchema }),
  z.object({ kind: z.literal('job'), jobId: idSchema, side: z.enum(['input', 'output']) }),
  z.object({ kind: z.literal('preview'), id: idSchema }),
]);

export const libraryQuerySchema = z.object({
  rootId: idSchema.nullable(),
  dir: absolutePath.nullable(),
  kinds: z.array(z.enum(MEDIA_KINDS)).max(3),
  search: z.string().max(200),
  minRating: z.number().int().min(0).max(5),
  label: z.enum(MEDIA_LABELS).nullable(),
  tags: z.array(z.string().min(1).max(60)).max(50),
  compressed: z.enum(['any', 'yes', 'no']),
  includeMissing: z.boolean(),
  sort: z.enum(LIBRARY_SORTS),
  order: z.enum(['asc', 'desc']),
  limit: z.number().int().min(1).max(1000),
  offset: z.number().int().min(0),
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
  'jobs:recommend': z.object({ id: idSchema }),
  'jobs:cancelRecommend': z.object({ id: idSchema }),
  'queue:state': voidSchema,
  'queue:setPaused': z.object({ paused: z.boolean() }),
  'history:list': z.object({
    limit: z.number().int().min(1).max(500),
    offset: z.number().int().min(0),
  }),
  'shell:showInFolder': z.object({ path: absolutePath }),
  'logs:export': z.object({ maskPaths: z.boolean() }),
  'library:roots.list': voidSchema,
  'library:roots.add': z.object({ includeSubfolders: z.boolean() }),
  'library:roots.addPath': z.object({ path: absolutePath, includeSubfolders: z.boolean() }),
  'library:roots.remove': z.object({ id: idSchema }),
  'library:roots.reindex': z.object({ id: idSchema }),
  'library:indexing.state': voidSchema,
  'library:indexing.cancel': voidSchema,
  'library:tree': z.object({ rootId: idSchema }),
  'library:items.query': libraryQuerySchema,
  'library:item.get': z.object({ id: idSchema }),
  'library:meta.set': z.object({
    id: idSchema,
    rating: z.number().int().min(0).max(5).optional(),
    label: z.enum(MEDIA_LABELS).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
  }),
  'library:tags.list': voidSchema,
  'library:tags.set': z.object({ id: idSchema, tags: z.array(z.string().min(1).max(60)).max(50) }),
  'library:thumb': z.object({ id: idSchema }),
  'library:scrub': z.object({ id: idSchema }),
  'library:source': z.object({ ref: mediaRefSchema }),
  'library:frame': z.object({ ref: mediaRefSchema, timeSec: z.number().min(0).max(1_000_000) }),
  'library:proxy.create': z.object({ id: idSchema }),
  'library:settingsPreview.create': z.object({
    jobId: idSchema,
    startSec: z.number().min(0).max(1_000_000),
    durationSec: z.number().min(1).max(60),
  }),
  'library:preview.cancel': z.object({ previewId: idSchema }),
  'library:previews.list': z.object({ sourceKey: z.string().min(1).max(200) }),
  'library:preview.remove': z.object({ previewId: idSchema }),
  'library:enqueue': z.object({ ids: z.array(idSchema).max(5000) }),
  'library:duplicates': voidSchema,
  'library:duplicates.verify': z.object({ ids: z.array(idSchema).min(2).max(200) }),
  'library:cache.stats': voidSchema,
  'library:cache.clear': voidSchema,
};
