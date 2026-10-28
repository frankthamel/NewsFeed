import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { AppError, onError, onNotFound } from './lib/errors.js';

// Placeholder; finalized in Task 2.
export type AuthUser = { id: string; name: string; email: string };
export type AppEnv = { Variables: { user: AuthUser } };

export function createApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', result.error.issues);
      }
    },
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

  app.get('/openapi.json', (c) =>
    c.json(
      app.getOpenAPI31Document({
        openapi: '3.1.0',
        info: { title: 'NewsFeed API', version: '1.0.0' },
      }),
    ),
  );
  app.get('/docs', swaggerUI({ url: '/openapi.json' }));

  return app;
}
