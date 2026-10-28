import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { post } from '../src/db/schema.js';
import { req, resetDb, signUp } from './helpers.js';

beforeEach(resetDb);

const createPost = async (token: string, text = 'hi') =>
  (await req('POST', '/api/v1/posts', { token, json: { type: 'text', text } })).body.id as string;

const iso = (ms = Date.now()) => new Date(ms).toISOString();

type Opts = { opId?: string; at?: number };

const like = (token: string, postId: string, o: Opts = {}) =>
  req('PUT', `/api/v1/posts/${postId}/like`, {
    token,
    json: { clientOpId: o.opId ?? randomUUID(), clientTimestamp: iso(o.at) },
  });

const unlike = (token: string, postId: string, o: Opts = {}) =>
  req('DELETE', `/api/v1/posts/${postId}/like`, {
    token,
    json: { clientOpId: o.opId ?? randomUUID(), clientTimestamp: iso(o.at) },
  });

const createComment = (token: string, postId: string, o: Opts & { id?: string; text?: string } = {}) =>
  req('POST', `/api/v1/posts/${postId}/comments`, {
    token,
    json: {
      id: o.id ?? randomUUID(),
      text: o.text ?? 'nice',
      clientOpId: o.opId ?? randomUUID(),
      clientTimestamp: iso(o.at),
    },
  });

const editComment = (token: string, id: string, text: string, baseVersion: number, o: Opts = {}) =>
  req('PATCH', `/api/v1/comments/${id}`, {
    token,
    json: { text, baseVersion, clientOpId: o.opId ?? randomUUID(), clientTimestamp: iso(o.at) },
  });

const deleteComment = (token: string, id: string, o: Opts = {}) =>
  req('DELETE', `/api/v1/comments/${id}`, {
    token,
    json: { clientOpId: o.opId ?? randomUUID(), clientTimestamp: iso(o.at) },
  });

const feed = async (token: string) => (await req('GET', '/api/v1/feed', { token })).body.items as any[];

describe('likes', () => {
  it('applies a like and reflects it in the feed', async () => {
    const a = await signUp();
    const id = await createPost(a.token);
    const r = await like(a.token, id);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('applied');
    expect(r.body.canonical.post).toMatchObject({ id, likeCount: 1, likedByMe: true, version: 2, deleted: false });
    const items = await feed(a.token);
    expect(items[0]).toMatchObject({ id, likedByMe: true, likeCount: 1 });
  });

  it('replaying the same opId is a duplicate with no extra effect', async () => {
    const a = await signUp();
    const id = await createPost(a.token);
    const opId = randomUUID();
    const t = Date.now();
    await like(a.token, id, { opId, at: t });
    const r = await like(a.token, id, { opId, at: t });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('duplicate');
    expect(r.body.canonical.post.likeCount).toBe(1);
  });

  it('concurrent replay of the same request yields applied + duplicate and one effect', async () => {
    const a = await signUp();
    const id = await createPost(a.token);
    const opId = randomUUID();
    const t = Date.now();
    const rs = await Promise.all([like(a.token, id, { opId, at: t }), like(a.token, id, { opId, at: t })]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(rs.map((r) => r.body.status).sort()).toEqual(['applied', 'duplicate']);
    const [p] = await db.select().from(post).where(eq(post.id, id));
    expect(p!.likeCount).toBe(1);
  });

  it('a stale unlike is superseded', async () => {
    const a = await signUp();
    const id = await createPost(a.token);
    const t = Date.now();
    await like(a.token, id, { at: t });
    const r = await unlike(a.token, id, { at: t - 10_000 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('superseded');
    expect(r.body.canonical.post).toMatchObject({ likedByMe: true, likeCount: 1 });
  });

  it('a far-future like is clamped so a later real-time unlike still applies', async () => {
    const a = await signUp();
    const id = await createPost(a.token);
    const r1 = await like(a.token, id, { at: Date.now() + 86_400_000 });
    expect(r1.body.status).toBe('applied');
    await new Promise((res) => setTimeout(res, 5));
    const r2 = await unlike(a.token, id, { at: Date.now() });
    expect(r2.body.status).toBe('applied');
    expect(r2.body.canonical.post).toMatchObject({ likedByMe: false, likeCount: 0 });
  });

  it('like, unlike, like with increasing timestamps', async () => {
    const a = await signUp();
    const id = await createPost(a.token);
    const t = Date.now() - 10_000;
    await like(a.token, id, { at: t });
    await unlike(a.token, id, { at: t + 1000 });
    const r = await like(a.token, id, { at: t + 2000 });
    expect(r.body.canonical.post).toMatchObject({ likeCount: 1, likedByMe: true, version: 4 });
  });

  it('liking a deleted post is rejected POST_DELETED', async () => {
    const a = await signUp();
    const id = await createPost(a.token);
    await req('DELETE', `/api/v1/posts/${id}`, { token: a.token });
    const r = await like(a.token, id);
    expect(r.status).toBe(410);
    expect(r.body.status).toBe('rejected');
    expect(r.body.error.code).toBe('POST_DELETED');
    expect(r.body.canonical.post.deleted).toBe(true);
  });

  it('liking a pending or unknown post is rejected POST_NOT_FOUND', async () => {
    const a = await signUp();
    const pending = randomUUID();
    await db.insert(post).values({ id: pending, authorId: a.user.id, type: 'image', status: 'pending' });
    for (const pid of [pending, randomUUID()]) {
      const r = await like(a.token, pid);
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('POST_NOT_FOUND');
      expect(r.body.canonical.post).toMatchObject({ deleted: true, likeCount: 0, commentCount: 0 });
    }
  });

  it('a non-uuid post id is rejected POST_NOT_FOUND, not a 500', async () => {
    const a = await signUp();
    const r = await like(a.token, 'not-a-uuid');
    expect(r.status).toBe(404);
    expect(r.body.status).toBe('rejected');
    expect(r.body.error.code).toBe('POST_NOT_FOUND');
  });

  it('a duplicate replay returns current state, not a stale snapshot', async () => {
    const a = await signUp();
    const id = await createPost(a.token);
    const op1 = randomUUID();
    const t = Date.now() - 5000;
    await like(a.token, id, { opId: op1, at: t });
    await unlike(a.token, id, { at: t + 1000 });
    const r = await like(a.token, id, { opId: op1, at: t });
    expect(r.body.status).toBe('duplicate');
    expect(r.body.canonical.post).toMatchObject({ likedByMe: false, likeCount: 0 });
  });

  it('a rejected op is recorded; its replay is a duplicate', async () => {
    const a = await signUp();
    const id = await createPost(a.token);
    await req('DELETE', `/api/v1/posts/${id}`, { token: a.token });
    const opId = randomUUID();
    expect((await like(a.token, id, { opId })).body.status).toBe('rejected');
    const r = await like(a.token, id, { opId });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('duplicate');
    expect(r.body.canonical.post.deleted).toBe(true);
  });
});

describe('comments', () => {
  it('creates with a client id and is idempotent on opId and comment id', async () => {
    const a = await signUp();
    const b = await signUp();
    const pid = await createPost(a.token);
    const cid = randomUUID();
    const opId = randomUUID();

    const r = await createComment(a.token, pid, { id: cid, opId });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('applied');
    expect(r.body.canonical.post.commentCount).toBe(1);
    expect(r.body.canonical.comment).toMatchObject({ id: cid, version: 1, edited: false, text: 'nice' });
    expect((await feed(a.token))[0].latestComments[0].id).toBe(cid);

    const replay = await createComment(a.token, pid, { id: cid, opId });
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe('duplicate');

    const sameId = await createComment(a.token, pid, { id: cid });
    expect(sameId.status).toBe(200);
    expect(sameId.body.status).toBe('duplicate');
    expect(sameId.body.canonical.post.commentCount).toBe(1);

    const other = await createComment(b.token, pid, { id: cid });
    expect(other.status).toBe(409);
    expect(other.body.status).toBe('rejected');
    expect(other.body.error.code).toBe('ID_CONFLICT');
  });

  it('edits with optimistic concurrency', async () => {
    const a = await signUp();
    const pid = await createPost(a.token);
    const cid = randomUUID();
    await createComment(a.token, pid, { id: cid });

    const ok = await editComment(a.token, cid, 'edited text', 1);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('applied');
    expect(ok.body.canonical.comment).toMatchObject({ version: 2, edited: true, text: 'edited text' });
    expect(ok.body.canonical.post.version).toBe(3);

    const stale = await editComment(a.token, cid, 'stale', 1);
    expect(stale.status).toBe(409);
    expect(stale.body.status).toBe('conflict');
    expect(stale.body.canonical.comment.text).toBe('edited text');
  });

  it("editing someone else's comment is forbidden; edit after delete is COMMENT_DELETED", async () => {
    const a = await signUp();
    const b = await signUp();
    const pid = await createPost(a.token);
    const cid = randomUUID();
    await createComment(a.token, pid, { id: cid });

    const forbidden = await editComment(b.token, cid, 'x', 1);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');

    await deleteComment(a.token, cid);
    const gone = await editComment(a.token, cid, 'x', 1);
    expect(gone.status).toBe(410);
    expect(gone.body.error.code).toBe('COMMENT_DELETED');
    expect(gone.body.canonical.comment).toBeNull();
  });

  it('delete is idempotent and decrements commentCount once', async () => {
    const a = await signUp();
    const pid = await createPost(a.token);
    const cid = randomUUID();
    await createComment(a.token, pid, { id: cid });

    const d1 = await deleteComment(a.token, cid);
    expect(d1.status).toBe(200);
    expect(d1.body.status).toBe('applied');
    expect(d1.body.canonical.comment).toBeNull();
    const d2 = await deleteComment(a.token, cid);
    expect(d2.status).toBe(200);
    expect(d2.body.status).toBe('applied');
    expect(d2.body.canonical.post).toMatchObject({ commentCount: 0, version: 3 });
  });

  it('the post author can delete a comment on their post; others cannot', async () => {
    const a = await signUp();
    const b = await signUp();
    const c = await signUp();
    const pid = await createPost(a.token);
    const cid = randomUUID();
    await createComment(b.token, pid, { id: cid });

    expect((await deleteComment(c.token, cid)).status).toBe(403);
    const r = await deleteComment(a.token, cid);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('applied');
    expect(r.body.canonical.post.commentCount).toBe(0);
  });

  it('unknown comment ids are COMMENT_NOT_FOUND', async () => {
    const a = await signUp();
    for (const cid of [randomUUID(), 'not-a-uuid']) {
      const e = await editComment(a.token, cid, 'x', 1);
      expect(e.status).toBe(404);
      expect(e.body.error.code).toBe('COMMENT_NOT_FOUND');
      const d = await deleteComment(a.token, cid);
      expect(d.status).toBe(404);
      expect(d.body.error.code).toBe('COMMENT_NOT_FOUND');
    }
  });

  it('commenting on a deleted post is rejected POST_DELETED', async () => {
    const a = await signUp();
    const pid = await createPost(a.token);
    await req('DELETE', `/api/v1/posts/${pid}`, { token: a.token });
    const r = await createComment(a.token, pid);
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe('POST_DELETED');
  });

  it('validates bodies', async () => {
    const a = await signUp();
    const pid = await createPost(a.token);
    const r = await createComment(a.token, pid, { text: '' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    const noAuth = await req('PUT', `/api/v1/posts/${pid}/like`, {
      json: { clientOpId: randomUUID(), clientTimestamp: iso() },
    });
    expect(noAuth.status).toBe(401);
  });
});
