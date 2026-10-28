import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../../auth/middleware.js';
import type { AppEnv } from '../../app.js';
import { db } from '../../db/client.js';
import { user } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { errorResponses } from '../../lib/openapi.js';
import { ProfileSchema } from './schemas.js';

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['Users'],
  summary: 'Get the authenticated user profile',
  security: [{ bearerAuth: [] }],
  middleware: [requireAuth] as const,
  responses: {
    200: { description: 'Profile', content: { 'application/json': { schema: ProfileSchema } } },
    ...errorResponses(401),
  },
});

export function usersRoutes() {
  const r = new OpenAPIHono<AppEnv>();
  r.openapi(meRoute, async (c) => {
    const [row] = await db.select().from(user).where(eq(user.id, c.var.user.id));
    if (!row) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    return c.json(
      {
        id: row.id,
        username: row.username ?? '',
        displayName: row.name,
        bio: row.bio,
        avatarUrl: row.image,
        createdAt: row.createdAt.toISOString(),
      },
      200,
    );
  });
  return r;
}
