import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { requireAuth } from '../../auth/middleware.js';
import type { AppEnv } from '../../app.js';
import { db } from '../../db/client.js';
import { PageQuerySchema, pageSchema } from '../../lib/cursor.js';
import { errorResponses } from '../../lib/openapi.js';
import { FeedItemSchema } from '../posts/schemas.js';
import { getFeed } from './service.js';

const feedRoute = createRoute({
  method: 'get',
  path: '/feed',
  tags: ['Feed'],
  summary: 'Get the home feed, newest first',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  request: { query: PageQuerySchema },
  responses: {
    200: {
      description: 'Page of feed items',
      content: { 'application/json': { schema: pageSchema(FeedItemSchema) } },
    },
    ...errorResponses(400, 401),
  },
});

export function feedRoutes() {
  const r = new OpenAPIHono<AppEnv>();
  r.openapi(feedRoute, async (c) => c.json(await getFeed(db, c.var.user.id, c.req.valid('query')), 200));
  return r;
}
