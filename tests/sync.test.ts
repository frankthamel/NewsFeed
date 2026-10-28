import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { req, resetDb, signUp } from './helpers.js';

beforeEach(resetDb);

const createPost = async (token: string, text = 'hi') =>
  (await req('POST', '/api/v1/posts', { token, json: { type: 'text', text } })).body.id as string;

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const op = (o: Record<string, unknown>) => ({ opId: randomUUID(), clientTimestamp: iso(), ...o });
const sync = (token: string, operations: unknown[]) => req('POST', '/api/v1/sync', { token, json: { operations } });
const detail = async (token: string, id: string) => (await req('GET', `/api/v1/posts/${id}`, { token })).body;

describe('POST /sync', () => {
  it('requires auth', async () => {
    const r = await req('POST', '/api/v1/sync', { json: { operations: [] } });
    expect(r.status).toBe(401);
  });

  it('applies an offline comment lifecycle (create, edit, delete) in order', async () => {
    const a = await signUp();
    const postId = await createPost(a.token);
    const commentId = randomUUID();
    const r = await sync(a.token, [
      op({ type: 'comment.create', postId, commentId, text: 'one' }),
      op({ type: 'comment.edit', commentId, text: 'two', baseVersion: 1 }),
      op({ type: 'comment.delete', commentId }),
    ]);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: any) => x.status)).toEqual(['applied', 'applied', 'applied']);
    expect((await detail(a.token, postId)).commentCount).toBe(0);
  });

  it('returns per-op statuses for a mixed batch, and replay is all duplicates', async () => {
    const a = await signUp();
    const b = await signUp();
    const postId = await createPost(a.token);
    const deletedPost = await createPost(a.token, 'gone');
    await req('DELETE', `/api/v1/posts/${deletedPost}`, { token: a.token });
    const commentId = randomUUID();
    await req('POST', `/api/v1/posts/${postId}/comments`, {
      token: b.token,
      json: { id: commentId, text: 'v1', clientOpId: randomUUID(), clientTimestamp: iso() },
    });
    await req('PATCH', `/api/v1/comments/${commentId}`, {
      token: b.token,
      json: { text: 'v2', baseVersion: 1, clientOpId: randomUUID(), clientTimestamp: iso() },
    });

    const now = Date.now();
    const likeOp = op({ type: 'like', postId, clientTimestamp: iso(now) });
    const batch = [
      likeOp,
      { ...likeOp },
      op({ type: 'unlike', postId, clientTimestamp: iso(now - 60_000) }),
      op({ type: 'comment.edit', commentId, text: 'stale', baseVersion: 1 }),
      op({ type: 'like', postId: deletedPost }),
    ];
    const r = await sync(b.token, batch);
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: any) => x.status)).toEqual([
      'applied',
      'duplicate',
      'superseded',
      'conflict',
      'rejected',
    ]);
    expect(r.body.results[4].error.code).toBe('POST_DELETED');
    expect(r.body.results.map((x: any) => x.opId)).toEqual(batch.map((x) => x.opId));

    const before = await detail(b.token, postId);
    const replay = await sync(b.token, batch);
    expect(replay.status).toBe(200);
    expect(replay.body.results.map((x: any) => x.status)).toEqual(Array(5).fill('duplicate'));
    const after = await detail(b.token, postId);
    expect(after.likeCount).toBe(before.likeCount);
    expect(after.commentCount).toBe(before.commentCount);
  });

  it('rejects an edit whose create was rejected earlier in the batch', async () => {
    const a = await signUp();
    const deletedPost = await createPost(a.token);
    await req('DELETE', `/api/v1/posts/${deletedPost}`, { token: a.token });
    const commentId = randomUUID();
    const r = await sync(a.token, [
      op({ type: 'comment.create', postId: deletedPost, commentId, text: 'x' }),
      op({ type: 'comment.edit', commentId, text: 'y', baseVersion: 1 }),
    ]);
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ status: 'rejected', error: { code: 'POST_DELETED' } });
    expect(r.body.results[1]).toMatchObject({ status: 'rejected', error: { code: 'COMMENT_NOT_FOUND' } });
  });

  it('validates the batch schema', async () => {
    const a = await signUp();
    const postId = await createPost(a.token);
    const many = await sync(a.token, Array.from({ length: 101 }, () => op({ type: 'like', postId })));
    expect(many.status).toBe(400);
    expect(many.body.error.code).toBe('VALIDATION_ERROR');
    const unknown = await sync(a.token, [op({ type: 'explode', postId })]);
    expect(unknown.status).toBe(400);
    const empty = await sync(a.token, []);
    expect(empty.status).toBe(400);
  });
});
