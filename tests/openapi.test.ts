import { describe, expect, it } from 'vitest';
import { app } from './helpers.js';

const TAGS = ['Auth', 'Users', 'Follows', 'Posts', 'Uploads', 'Feed', 'Interactions', 'Sync'];
const METHODS = ['get', 'put', 'post', 'delete', 'patch'];

async function spec(): Promise<any> {
  const res = await app.request('/openapi.json');
  expect(res.status).toBe(200);
  return res.json();
}

describe('OpenAPI document', () => {
  it('documents every /api/v1 operation with summary, description, tag and bearer security', async () => {
    const doc = await spec();
    const v1 = Object.entries<any>(doc.paths).filter(([p]) => p.startsWith('/api/v1'));
    expect(v1.length).toBeGreaterThan(20);
    for (const [path, item] of v1) {
      for (const method of METHODS.filter((m) => item[m])) {
        const op = item[method];
        const where = `${method.toUpperCase()} ${path}`;
        expect(op.summary, `${where} summary`).toBeTruthy();
        expect(op.description, `${where} description`).toBeTruthy();
        expect(op.tags?.length, `${where} tags`).toBeGreaterThan(0);
        for (const t of op.tags) expect(TAGS, `${where} tag ${t}`).toContain(t);
        expect(op.security, `${where} security`).toEqual([{ bearerAuth: [] }]);
      }
    }
  });

  it('tags Better Auth paths as Auth and registers bearerAuth', async () => {
    const doc = await spec();
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    const authPaths = Object.keys(doc.paths).filter((p) => p.startsWith('/api/auth'));
    expect(authPaths.length).toBeGreaterThan(0);
  });

  it('sync request body references every operation type', async () => {
    const doc = await spec();
    const body = doc.paths['/api/v1/sync'].post.requestBody.content['application/json'].schema;
    const text = JSON.stringify({ body, schemas: doc.components.schemas });
    for (const t of ['like', 'unlike', 'comment.create', 'comment.edit', 'comment.delete']) {
      expect(text).toContain(`"${t}"`);
    }
  });

  it('provides request body examples for upload start, sync and comment create', async () => {
    const doc = await spec();
    const hasExample = (path: string) => {
      const s = doc.paths[path].post.requestBody.content['application/json'];
      const ref: string | undefined = s.schema?.$ref;
      const target = ref ? doc.components.schemas[ref.split('/').pop()!] : s.schema;
      return JSON.stringify({ s, target }).includes('example');
    };
    expect(hasExample('/api/v1/posts/uploads')).toBe(true);
    expect(hasExample('/api/v1/sync')).toBe(true);
    expect(hasExample('/api/v1/posts/{id}/comments')).toBe(true);
  });
});
