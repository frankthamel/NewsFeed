import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { req, resetDb, signUp } from './helpers.js';

beforeEach(resetDb);

const createPost = async (token: string, text = 'hi') =>
  (await req('POST', '/api/v1/posts', { token, json: { type: 'text', text } })).body as { id: string; version: number };
const iso = () => new Date().toISOString();
const refresh = (token: string, posts: { id: string; version: number }[]) =>
  req('POST', '/api/v1/posts/refresh', { token, json: { posts } });

describe('POST /posts/refresh', () => {
  it('requires auth', async () => {
    expect((await req('POST', '/api/v1/posts/refresh', { json: { posts: [] } })).status).toBe(401);
  });

  it('omits unchanged posts', async () => {
    const a = await signUp();
    const p = await createPost(a.token);
    const r = await refresh(a.token, [{ id: p.id, version: p.version }]);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ updated: [], deleted: [] });
  });

  it('returns a post liked by someone else with the new likeCount', async () => {
    const a = await signUp();
    const b = await signUp();
    const p = await createPost(a.token);
    await req('PUT', `/api/v1/posts/${p.id}/like`, {
      token: b.token,
      json: { clientOpId: randomUUID(), clientTimestamp: iso() },
    });
    const r = await refresh(a.token, [{ id: p.id, version: p.version }]);
    expect(r.body.deleted).toEqual([]);
    expect(r.body.updated).toHaveLength(1);
    expect(r.body.updated[0]).toMatchObject({ id: p.id, likeCount: 1 });
    expect(r.body.updated[0].version).toBeGreaterThan(p.version);
  });

  it('returns a post whose comment was edited since', async () => {
    const a = await signUp();
    const p = await createPost(a.token);
    const id = randomUUID();
    await req('POST', `/api/v1/posts/${p.id}/comments`, {
      token: a.token,
      json: { id, text: 'v1', clientOpId: randomUUID(), clientTimestamp: iso() },
    });
    const mid = (await req('GET', `/api/v1/posts/${p.id}`, { token: a.token })).body;
    await req('PATCH', `/api/v1/comments/${id}`, {
      token: a.token,
      json: { text: 'v2', baseVersion: 1, clientOpId: randomUUID(), clientTimestamp: iso() },
    });
    const r = await refresh(a.token, [{ id: p.id, version: mid.version }]);
    expect(r.body.updated).toHaveLength(1);
    expect(r.body.updated[0].latestComments[0].text).toBe('v2');
  });

  it('reports deleted, unknown and non-uuid ids; keeps input order; dedupes', async () => {
    const a = await signUp();
    const p1 = await createPost(a.token);
    const p2 = await createPost(a.token);
    const gone = await createPost(a.token);
    await req('DELETE', `/api/v1/posts/${gone.id}`, { token: a.token });
    const unknown = randomUUID();
    const r = await refresh(a.token, [
      { id: p2.id, version: 0 },
      { id: gone.id, version: gone.version },
      { id: 'not-a-uuid', version: 1 },
      { id: p1.id, version: 0 },
      { id: p2.id, version: 0 },
      { id: unknown, version: 1 },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.updated.map((x: any) => x.id)).toEqual([p2.id, p1.id]);
    expect(r.body.deleted).toEqual([gone.id, 'not-a-uuid', unknown]);
  });

  it('validates size and shape', async () => {
    const a = await signUp();
    const many = await refresh(a.token, Array.from({ length: 201 }, () => ({ id: randomUUID(), version: 1 })));
    expect(many.status).toBe(400);
    expect(many.body.error.code).toBe('VALIDATION_ERROR');
    expect((await refresh(a.token, [])).status).toBe(400);
  });
});
