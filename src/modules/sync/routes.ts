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
  .openapi('SyncBody');
const SyncResponseSchema = z.object({ results: z.array(OpResultSchema) }).openapi('SyncResponse');

const syncRoute = createRoute({
  method: 'post',
  path: '/sync',
  tags: ['Sync'],
  summary: 'Apply a batch of offline operations in order (each idempotent on opId)',
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
