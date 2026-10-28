import { createMiddleware } from 'hono/factory';
import { AppError } from '../lib/errors.js';
import type { AppEnv } from '../app.js';
import { auth } from './auth.js';

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  const u = session.user as { id: string; name: string; username?: string | null };
  c.set('user', { id: u.id, username: u.username ?? '', name: u.name });
  await next();
});
