import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { requireAuth } from '../../auth/middleware.js';
import type { AppEnv } from '../../app.js';
import { db } from '../../db/client.js';
import { errorResponses } from '../../lib/openapi.js';
import { applyOperation } from '../interactions/operations.js';
import { OperationSchema, OpResultSchema, type OpResult } from '../interactions/schemas.js';

const json = <T extends object>(schema: T) => ({ 'application/json': { schema } });

const SyncBodySchema = z
  .object({ operations: z.array(OperationSchema).min(1).max(100) })
  .openapi('SyncBody', {
    example: {
      operations: [
        {
          opId: '11111111-1111-4111-8111-111111111111',
          type: 'like',
          postId: '22222222-2222-4222-8222-222222222222',
          clientTimestamp: '2026-10-28T09:30:00.000Z',
        },
        {
          opId: '33333333-3333-4333-8333-333333333333',
          type: 'comment.create',
          postId: '22222222-2222-4222-8222-222222222222',
          commentId: '44444444-4444-4444-8444-444444444444',
          text: 'Written offline',
          clientTimestamp: '2026-10-28T09:31:00.000Z',
        },
        {
          opId: '55555555-5555-4555-8555-555555555555',
          type: 'comment.edit',
          commentId: '44444444-4444-4444-8444-444444444444',
          text: 'Written offline (edited)',
          baseVersion: 1,
          clientTimestamp: '2026-10-28T09:32:00.000Z',
        },
      ],
    },
  });
const SyncResponseSchema = z.object({ results: z.array(OpResultSchema) }).openapi('SyncResponse');

const syncRoute = createRoute({
  method: 'post',
  path: '/sync',
  tags: ['Sync'],
  summary: 'Apply a batch of offline operations in order (each idempotent on opId)',
  description: "Replays up to 100 operations queued while offline (like, unlike, comment.create, comment.edit, comment.delete) in order, so a create can be followed by an edit or delete of the same comment. Each operation is idempotent on opId and gets its own OpResult, in input order; one failing operation never fails the batch. Statuses: applied, duplicate (current canonical state returned), superseded (newer like/unlike already stored), conflict (stale baseVersion), rejected (see error.code). Timestamps more than 60 s in the future are clamped to server time. Always overwrite local state with each result's 'canonical'.",
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { body: { required: true, content: json(SyncBodySchema) } },
  responses: {
    200: { description: 'One result per operation, in input order', content: json(SyncResponseSchema) },
    ...errorResponses(400, 401),
  },
});

export function syncRoutes() {
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(syncRoute, async (c) => {
    const { operations } = c.req.valid('json');
    const results: OpResult[] = [];
    // Sequential on purpose: later ops may depend on earlier ones (create -> edit -> delete).
    for (const op of operations) {
      results.push(await applyOperation(db, c.var.user.id, op));
    }
    return c.json({ results }, 200);
  });

  return r;
}
