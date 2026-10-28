import { describe, it, expect } from 'vitest';
import { app, req } from './helpers.js';

describe('app shell', () => {
  it('GET /health returns ok', async () => {
    const r = await req('GET', '/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'ok' });
  });
  it('unknown route returns error shape', async () => {
    const r = await req('GET', '/api/v1/nope');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });
  it('serves openapi with bearer scheme and swagger ui', async () => {
    const spec = await req('GET', '/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
    const ui = await app.request('/docs');
    expect(ui.status).toBe(200);
  });
});
