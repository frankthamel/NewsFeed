import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { req, resetDb, signUp } from './helpers.js';

beforeEach(resetDb);

// iOS `UUID().uuidString` is uppercase; the server must treat ids case-insensitively.
const upper = () => randomUUID().toUpperCase();
const iso = () => new Date().toISOString();
const createPost = async (token: string) =>
  (await req('POST', '/api/v1/posts', { token, json: { type: 'text', text: 'hi' } })).body as {
    id: string;
    version: number;
  };

describe('uppercase uuids', () => {
  it('refresh with an uppercase live id does not report it deleted', async () => {
    const a = await signUp();
    const p = await createPost(a.token);
    const unchanged = await req('POST', '/api/v1/posts/refresh', {
      token: a.token,
      json: { posts: [{ id: p.id.toUpperCase(), version: p.version }] },
    });
    expect(unchanged.status).toBe(200);
    expect(unchanged.body).toEqual({ updated: [], deleted: [] });

    const stale = await req('POST', '/api/v1/posts/refresh', {
      token: a.token,
      json: { posts: [{ id: p.id.toUpperCase(), version: p.version - 1 }] },
    });
    expect(stale.body.deleted).toEqual([]);
    expect(stale.body.updated.map((x: any) => x.id)).toEqual([p.id]);
  });

  it('comment.create with uppercase postId and comment id returns the canonical comment; replay is a duplicate', async () => {
    const a = await signUp();
    const p = await createPost(a.token);
    const id = upper();
    const body = () => ({ id, text: 'hello', clientOpId: upper(), clientTimestamp: iso() });

    const r = await req('POST', `/api/v1/posts/${p.id.toUpperCase()}/comments`, { token: a.token, json: body() });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('applied');
    expect(r.body.canonical.comment).not.toBeNull();
    expect(r.body.canonical.comment.id).toBe(id.toLowerCase());
    expect(r.body.canonical.comment.postId).toBe(p.id);
    expect(r.body.canonical.post).toMatchObject({ id: p.id, commentCount: 1, deleted: false });

    const again = await req('POST', `/api/v1/posts/${p.id.toUpperCase()}/comments`, { token: a.token, json: body() });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('duplicate');
    expect(again.body.canonical.comment.id).toBe(id.toLowerCase());
  });

  it('like with an uppercase post id works and replays as duplicate', async () => {
    const a = await signUp();
    const p = await createPost(a.token);
    const opId = upper();
    const json = { clientOpId: opId, clientTimestamp: iso() };
    const r = await req('PUT', `/api/v1/posts/${p.id.toUpperCase()}/like`, { token: a.token, json });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('applied');
    expect(r.body.opId).toBe(opId.toLowerCase());
    expect(r.body.canonical.post).toMatchObject({ id: p.id, likeCount: 1, likedByMe: true, deleted: false });

    const lower = await req('PUT', `/api/v1/posts/${p.id}/like`, {
      token: a.token,
      json: { clientOpId: opId.toLowerCase(), clientTimestamp: iso() },
    });
    expect(lower.body.status).toBe('duplicate');
  });

  it('sync accepts uppercase ids', async () => {
    const a = await signUp();
    const p = await createPost(a.token);
    const cid = upper();
    const r = await req('POST', '/api/v1/sync', {
      token: a.token,
      json: {
        operations: [
          { opId: upper(), type: 'comment.create', postId: p.id.toUpperCase(), commentId: cid, text: 'x', clientTimestamp: iso() },
          { opId: upper(), type: 'comment.edit', commentId: cid, text: 'y', baseVersion: 1, clientTimestamp: iso() },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: any) => x.status)).toEqual(['applied', 'applied']);
    expect(r.body.results[1].canonical.comment).toMatchObject({ id: cid.toLowerCase(), text: 'y', version: 2 });
  });

  it('uppercase ids work on post detail, delete and upload routes', async () => {
    const a = await signUp();
    const p = await createPost(a.token);
    expect((await req('GET', `/api/v1/posts/${p.id.toUpperCase()}`, { token: a.token })).status).toBe(200);
    const start = await req('POST', '/api/v1/posts/uploads', {
      token: a.token,
      json: { type: 'image', files: [{ kind: 'image', contentType: 'image/jpeg', sizeBytes: 10 }] },
    });
    expect(start.status).toBe(201);
    const status = await req('GET', `/api/v1/posts/uploads/${start.body.uploadId.toUpperCase()}`, { token: a.token });
    expect(status.status).toBe(200);
    expect(status.body.uploadId).toBe(start.body.uploadId);
    expect((await req('DELETE', `/api/v1/posts/${p.id.toUpperCase()}`, { token: a.token })).status).toBe(204);
  });
});
