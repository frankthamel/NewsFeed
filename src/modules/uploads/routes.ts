import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { requireAuth } from '../../auth/middleware.js';
import type { AppEnv } from '../../app.js';
import { db } from '../../db/client.js';
import { errorResponses } from '../../lib/openapi.js';
import { FeedItemSchema } from '../posts/schemas.js';
import { StartUploadSchema } from './limits.js';
import { completeUpload, getUpload, startUpload } from './service.js';

const security = [{ bearerAuth: [] }];
const json = <T extends object>(schema: T) => ({ 'application/json': { schema } });
// Plain string (not uuid): a malformed id must yield 404 UPLOAD_NOT_FOUND, not 400.
const UploadIdParam = z.object({ uploadId: z.string() });
const Kind = z.enum(['image', 'video', 'thumbnail']);

const StartResponseSchema = z
  .object({
    uploadId: z.string(),
    postId: z.string(),
    expiresAt: z.string(),
    uploads: z.array(
      z.object({
        mediaId: z.string(),
        kind: Kind,
        position: z.number().int(),
        url: z.string(),
        method: z.literal('PUT'),
        headers: z.record(z.string(), z.string()),
      }),
    ),
  })
  .openapi('StartUploadResponse');

const UploadStatusSchema = z
  .object({
    uploadId: z.string(),
    postId: z.string(),
    status: z.enum(['open', 'completed', 'expired']),
    expiresAt: z.string(),
    media: z.array(z.object({ mediaId: z.string(), kind: Kind, uploaded: z.boolean() })),
  })
  .openapi('UploadStatus');

const startRoute = createRoute({
  method: 'post',
  path: '/posts/uploads',
  tags: ['Uploads'],
  summary: 'Start a media post upload and get presigned PUT URLs',
  security,
  middleware: [requireAuth] as const,
  request: { body: { required: true, content: json(StartUploadSchema) } },
  responses: { 201: { description: 'Upload started', content: json(StartResponseSchema) }, ...errorResponses(400, 401) },
});

const completeRoute = createRoute({
  method: 'post',
  path: '/posts/uploads/{uploadId}/complete',
  tags: ['Uploads'],
  summary: 'Verify the uploaded files and publish the post (idempotent)',
  security,
  middleware: [requireAuth] as const,
  request: { params: UploadIdParam },
  responses: {
    200: { description: 'Published post', content: json(FeedItemSchema) },
    ...errorResponses(401, 404, 409, 410, 422),
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/posts/uploads/{uploadId}',
  tags: ['Uploads'],
  summary: 'Upload status with per-file uploaded flags',
  security,
  middleware: [requireAuth] as const,
  request: { params: UploadIdParam },
  responses: { 200: { description: 'Upload status', content: json(UploadStatusSchema) }, ...errorResponses(401, 404) },
});

export function uploadsRoutes() {
  const r = new OpenAPIHono<AppEnv>();
  r.openapi(startRoute, async (c) => c.json(await startUpload(db, c.var.user.id, c.req.valid('json')), 201));
  r.openapi(completeRoute, async (c) =>
    c.json(await completeUpload(db, c.var.user.id, c.req.valid('param').uploadId), 200),
  );
  r.openapi(getRoute, async (c) => c.json(await getUpload(db, c.var.user.id, c.req.valid('param').uploadId), 200));
  return r;
}
