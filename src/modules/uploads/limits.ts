import { z } from '@hono/zod-openapi';
import { AppError } from '../../lib/errors.js';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime'] as const;
export const MAX_IMAGE_BYTES = 10_485_760;
export const MAX_VIDEO_BYTES = 104_857_600;
export const MAX_IMAGES = 10;
export const UPLOAD_TTL_MS = 3_600_000;

export const FileKindSchema = z.enum(['image', 'video', 'thumbnail']);

export const StartUploadSchema = z
  .object({
    type: z.enum(['image', 'video']),
    text: z.string().max(5000).optional(),
    files: z
      .array(
        z.object({
          kind: FileKindSchema,
          contentType: z.string(),
          sizeBytes: z.number().int().positive(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          durationSec: z.number().nonnegative().optional(),
        }),
      )
      .max(20),
  })
  .openapi('StartUpload');
export type StartUploadBody = z.infer<typeof StartUploadSchema>;

const bad = (reason: string): never => {
  throw new AppError(400, 'VALIDATION_ERROR', reason);
};

export function validateFiles(type: 'image' | 'video', files: StartUploadBody['files']): void {
  const count = (k: string) => files.filter((f) => f.kind === k).length;
  if (type === 'image') {
    if (count('image') < 1 || count('image') > MAX_IMAGES) bad(`An image post needs 1-${MAX_IMAGES} images`);
    if (files.length !== count('image')) bad('An image post may only contain image files');
  } else {
    if (count('video') !== 1) bad('A video post needs exactly 1 video');
    if (count('thumbnail') > 1) bad('A video post allows at most 1 thumbnail');
    if (count('image') > 0) bad('A video post cannot contain image files');
  }
  for (const f of files) {
    const isVideo = f.kind === 'video';
    const allowed: readonly string[] = isVideo ? VIDEO_TYPES : IMAGE_TYPES;
    if (!allowed.includes(f.contentType)) bad(`Unsupported content type for ${f.kind}: ${f.contentType}`);
    const max = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (f.sizeBytes > max) bad(`${f.kind} exceeds the ${max} byte limit`);
  }
}
