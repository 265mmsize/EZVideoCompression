/**
 * IPC 요청 검증 스키마 (zod).
 *
 * 메인 프로세스는 렌더러가 보낸 모든 요청을 이 스키마로 검증한 뒤 처리한다.
 * 렌더러는 신뢰할 수 없는 영역이므로 타입 선언만으로는 충분하지 않다.
 */
import { z } from 'zod';
import {
  CANVAS_PRESETS,
  COMPRESSION_MODES,
  EDIT_PRESETS,
  IMAGE_EXPORT_FORMATS,
  TEXT_X,
  TEXT_Y,
  TRANSITIONS,
  WATERMARK_POSITIONS,
  LIBRARY_SORTS,
  MEDIA_KINDS,
  MEDIA_LABELS,
  OUTPUT_CONTAINERS,
  PRESETS,
  RESIZE_FILTERS,
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

const MAX_IMAGE_DIM = 16_384;
const pixel = z.number().int().min(0).max(MAX_IMAGE_DIM);
export const imageEditOpsSchema = z.object({
  crop: z
    .object({
      x: pixel,
      y: pixel,
      width: z.number().int().min(1).max(MAX_IMAGE_DIM),
      height: z.number().int().min(1).max(MAX_IMAGE_DIM),
    })
    .nullable(),
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  flipH: z.boolean(),
  flipV: z.boolean(),
  angle: z.number().min(-45).max(45),
  fillColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, '색은 #rrggbb 형식이어야 합니다'),
  resize: z
    .object({
      width: z.number().int().min(1).max(MAX_IMAGE_DIM),
      height: z.number().int().min(1).max(MAX_IMAGE_DIM),
      filter: z.enum(RESIZE_FILTERS),
    })
    .nullable(),
  enhance: z.object({
    sharpen: z.number().min(0).max(2),
    denoise: z.number().min(0).max(10),
    brightness: z.number().min(-0.5).max(0.5),
    contrast: z.number().min(0.5).max(2),
    saturation: z.number().min(0).max(3),
    gamma: z.number().min(0.5).max(2),
    autoLevel: z.boolean(),
  }),
});

const rotationSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const sec = z.number().min(0).max(1_000_000);
const editTextSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().max(500),
  x: z.enum(TEXT_X),
  y: z.enum(TEXT_Y),
  fontSize: z.number().min(8).max(400),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  boxed: z.boolean(),
  startSec: sec,
  endSec: sec.nullable(),
});
const editClipSchema = z.object({
  id: z.string().min(1).max(64),
  path: absolutePath,
  fileName: z.string().min(1).max(255),
  sourceDurationSec: sec,
  sourceWidth: z.number().int().min(1).max(16_384),
  sourceHeight: z.number().int().min(1).max(16_384),
  hasAudio: z.boolean(),
  inSec: sec,
  outSec: sec,
  speed: z.number().min(0.25).max(4),
  volume: z.number().min(0).max(2),
  mute: z.boolean(),
  rotate: rotationSchema,
  flipH: z.boolean(),
  flipV: z.boolean(),
  filters: z.object({
    brightness: z.number().min(-0.5).max(0.5),
    contrast: z.number().min(0.5).max(2),
    saturation: z.number().min(0).max(3),
    sharpen: z.number().min(0).max(2),
    denoise: z.number().min(0).max(10),
  }),
  stabilize: z.boolean(),
  transition: z.object({ type: z.enum(TRANSITIONS), durationSec: z.number().min(0.1).max(5) }),
  texts: z.array(editTextSchema).max(20),
});
export const editProjectSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  clips: z.array(editClipSchema).max(200),
  music: z
    .object({
      path: absolutePath,
      fileName: z.string().min(1).max(255),
      sourceDurationSec: sec,
      volume: z.number().min(0).max(2),
      fadeInSec: z.number().min(0).max(30),
      fadeOutSec: z.number().min(0).max(30),
      loop: z.boolean(),
      originalMix: z.number().min(0).max(1),
    })
    .nullable(),
  watermark: z
    .object({
      path: absolutePath,
      fileName: z.string().min(1).max(255),
      position: z.enum(WATERMARK_POSITIONS),
      scale: z.number().min(0.05).max(1),
      opacity: z.number().min(0).max(1),
    })
    .nullable(),
  canvas: z.object({
    preset: z.enum(CANVAS_PRESETS),
    fps: z.union([z.literal('auto'), z.literal(24), z.literal(30), z.literal(60)]),
  }),
  output: z.object({
    container: z.enum(OUTPUT_CONTAINERS),
    codec: z.enum(VIDEO_CODECS),
    crf: z.number().int().min(10).max(40),
    preset: z.enum(EDIT_PRESETS),
  }),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
});
const exportTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('suffix'),
    suffix: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[^\\/:*?"<>|\0]+$/, '접미사에 사용할 수 없는 문자가 있습니다'),
  }),
  z.object({ kind: z.literal('path'), path: absolutePath }),
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
  'image:open': z.object({ path: absolutePath }),
  'image:pickOpen': voidSchema,
  'image:preview': z.object({
    path: absolutePath,
    ops: imageEditOpsSchema,
    maxWidth: z.number().int().min(64).max(4096),
  }),
  'image:export': z.object({
    path: absolutePath,
    ops: imageEditOpsSchema,
    format: z.enum(IMAGE_EXPORT_FORMATS),
    quality: z.number().int().min(1).max(100),
    target: exportTargetSchema,
  }),
  'image:pickSavePath': z.object({
    defaultName: z.string().min(1).max(255),
    format: z.enum(['jpeg', 'png', 'webp']),
  }),
  'edit:projects.list': voidSchema,
  'edit:project.create': z.object({ name: z.string().min(1).max(120) }),
  'edit:project.get': z.object({ id: idSchema }),
  'edit:project.save': z.object({ project: editProjectSchema }),
  'edit:project.delete': z.object({ id: idSchema }),
  'edit:source.probe': z.object({ path: absolutePath }),
  'edit:pickMedia': z.object({ kind: z.enum(['video', 'audio', 'image']) }),
  'edit:frame': z.object({ path: absolutePath, timeSec: sec }),
  'edit:render': z.object({
    projectId: idSchema,
    mode: z.enum(['proxy', 'export']),
    target: exportTargetSchema.nullable(),
  }),
  'edit:render.cancel': z.object({ renderId: idSchema }),
  'edit:pickExportPath': z.object({
    defaultName: z.string().min(1).max(255),
    ext: z.enum(['mp4', 'mkv']),
  }),
  'capture:sources': voidSchema,
  'capture:take': z.object({
    sourceId: z.string().min(1).max(200),
    delaySec: z.number().int().min(0).max(30),
    hideApp: z.boolean(),
  }),
};
