import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { auth } from './auth/auth.js';
import { usersRoutes } from './modules/users/routes.js';
import { feedRoutes } from './modules/feed/routes.js';
import { postsRoutes } from './modules/posts/routes.js';
import { followsRoutes } from './modules/follows/routes.js';
import { onError, onNotFound, validationHook } from './lib/errors.js';

export type AuthUser = { id: string; username: string; name: string };
export type AppEnv = { Variables: { user: AuthUser } };

export function createApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: validationHook,
  });

  if (process.env.NODE_ENV !== 'test') app.use('*', logger());
  app.use('*', cors({ origin: '*', exposeHeaders: ['set-auth-token'] }));

  app.onError(onError);
  app.notFound(onNotFound);

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
  });

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  app.route('/api/v1', usersRoutes());
  app.route('/api/v1', postsRoutes());
  app.route('/api/v1', feedRoutes());
  app.route('/api/v1', followsRoutes());

  type AuthSpec = { paths?: Record<string, Record<string, unknown>> };
  let authSpec: Promise<AuthSpec> | undefined;
  app.get('/openapi.json', async (c) => {
    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'NewsFeed API', version: '1.0.0' },
    });
    authSpec ??= auth.api.generateOpenAPISchema() as unknown as Promise<AuthSpec>;
    const spec = await authSpec;
    const paths: Record<string, unknown> = (doc.paths ??= {});
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      const tagged: Record<string, unknown> = {};
      for (const [method, op] of Object.entries(item)) {
        tagged[method] = op && typeof op === 'object' ? { ...op, tags: ['Auth'] } : op;
      }
      paths[`/api/auth${path}`] = tagged;
    }
    return c.json(doc);
  });
  app.get('/docs', swaggerUI({ url: '/openapi.json' }));

  return app;
}
