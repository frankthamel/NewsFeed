import { describe, it, expect } from 'vitest';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { onError, validationHook } from '../src/lib/errors.js';

function makeApp() {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.onError(onError);
  app.openapi(
    createRoute({
      method: 'post',
      path: '/echo',
      request: { body: { content: { 'application/json': { schema: z.object({ name: z.string() }) } } } },
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ name: z.string() }) } } } },
    }),
    (c) => c.json({ name: c.req.valid('json').name }, 200),
  );
  app.get('/too-large', () => {
    throw new HTTPException(413, { message: 'Payload too large' });
  });
  app.get('/unsupported', () => {
    throw new HTTPException(415, { message: 'Unsupported media type' });
  });
  app.get('/teapot', () => {
    throw new HTTPException(418, { message: 'teapot' });
  });
  return app;
}

const post = (app: ReturnType<typeof makeApp>, body: string) =>
  app.request('/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe('error handling', () => {
  it('malformed JSON body returns 400 VALIDATION_ERROR, not 500', async () => {
    const res = await post(makeApp(), '{bad');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });
  it('zod validation failure returns 400 VALIDATION_ERROR with details', async () => {
    const res = await post(makeApp(), JSON.stringify({ name: 5 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(body.error.details)).toBe(true);
  });
  it('other HTTPException keeps its status with INTERNAL code', async () => {
    const res = await makeApp().request('/teapot');
    expect(res.status).toBe(418);
    expect((await res.json()).error.code).toBe('INTERNAL');
  });
  it('413 and 415 HTTPExceptions keep their status with VALIDATION_ERROR', async () => {
    for (const [path, status] of [['/too-large', 413], ['/unsupported', 415]] as const) {
      const res = await makeApp().request(path);
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
    }
  });
});
