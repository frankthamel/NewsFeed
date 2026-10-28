import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { comment, like, post } from '../src/db/schema.js';
import { encodeCursor } from '../src/lib/cursor.js';
import { follow, req, resetDb, signUp } from './helpers.js';

beforeEach(resetDb);

const feed = async (token: string, qs = '') => (await req('GET', `/api/v1/feed${qs}`, { token })).body;
const createPost = (token: string, text: string, extra: object = {}) =>
  req('POST', '/api/v1/posts', { token, json: { type: 'text', text, ...extra } });

describe('feed', () => {
  it('follower sees new post; non-follower does not; author sees own', async () => {
    const a = await signUp();
    const b = await signUp();
    const c = await signUp();
    await follow(a.token, b.user.id);
    const p = await createPost(b.token, 'hi');
    expect(p.status).toBe(201);
    expect((await feed(a.token)).items[0].id).toBe(p.body.id);
    expect((await feed(c.token)).items).toEqual([]);
    expect((await feed(b.token)).items.map((i: any) => i.id)).toContain(p.body.id);
  });

  it('feed item shape', async () => {
    const a = await signUp();
    const b = await signUp({ username: 'bob' });
    await follow(a.token, b.user.id);
    await createPost(b.token, 'hello');
    const item = (await feed(a.token)).items[0];
    expect(item).toMatchObject({
      type: 'text',
      text: 'hello',
      likeCount: 0,
      commentCount: 0,
      likedByMe: false,
      latestComments: [],
      media: [],
      version: 1,
      author: { username: 'bob' },
    });
  });

  it('cursor pagination has no gaps or duplicates when posts arrive mid-scroll', async () => {
    const a = await signUp();
    const b = await signUp();
    await follow(a.token, b.user.id);
    const original: string[] = [];
    for (let i = 0; i < 25; i++) original.unshift((await createPost(b.token, `p${i}`)).body.id);
    const collected: string[] = [];
    let page = await feed(a.token, '?limit=10');
    collected.push(...page.items.map((i: any) => i.id));
    for (let i = 0; i < 5; i++) await createPost(b.token, `new${i}`);
    while (page.nextCursor) {
      page = await feed(a.token, `?limit=10&cursor=${page.nextCursor}`);
      collected.push(...page.items.map((i: any) => i.id));
    }
    expect(collected).toEqual(original);
    expect(page.nextCursor).toBeNull();
  });

  it('tampered cursor returns 400 INVALID_CURSOR', async () => {
    const { token } = await signUp();
    const r = await req('GET', '/api/v1/feed?cursor=bogus', { token });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_CURSOR');
  });

  it('cursor with valid timestamp but non-uuid id returns 400 INVALID_CURSOR', async () => {
    const { token, user } = await signUp();
    const cursor = encodeCursor({ t: new Date().toISOString(), id: 'not-a-uuid' });
    for (const path of ['/api/v1/feed', `/api/v1/users/${user.id}/posts`]) {
      const r = await req('GET', `${path}?cursor=${cursor}`, { token });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_CURSOR');
    }
  });

  it('limit above 50 is rejected', async () => {
    const { token } = await signUp();
    const r = await req('GET', '/api/v1/feed?limit=51', { token });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires auth', async () => {
    expect((await req('GET', '/api/v1/feed')).status).toBe(401);
  });

  it('latestComments are the newest two, oldest-first; likedByMe reflects likes', async () => {
    const a = await signUp();
    const b = await signUp();
    await follow(a.token, b.user.id);
    const p = (await createPost(b.token, 'x')).body;
    const base = Date.now() - 10_000;
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [i, id] of ids.entries()) {
      await db.insert(comment).values({
        id,
        postId: p.id,
        authorId: b.user.id,
        text: `c${i}`,
        clientCreatedAt: new Date(base + i * 1000),
        createdAt: new Date(base + i * 1000),
        updatedAt: new Date(base + i * 1000),
      });
    }
    await db.update(post).set({ commentCount: 3 }).where(eqId(p.id));
    await db.insert(like).values({ postId: p.id, userId: a.user.id, liked: true, clientUpdatedAt: new Date() });
    const item = (await feed(a.token)).items[0];
    expect(item.latestComments.map((c: any) => c.text)).toEqual(['c1', 'c2']);
    expect(item.latestComments[0]).toMatchObject({ postId: p.id, edited: false, author: { id: b.user.id } });
    expect(item.commentCount).toBe(3);
    expect(item.likedByMe).toBe(true);
    expect((await feed(b.token)).items[0].likedByMe).toBe(false);
  });
});

const eqId = (id: string) => eq(post.id, id);

describe('delete post', () => {
  it('removes it from all feeds; non-author gets 403; second delete 404', async () => {
    const a = await signUp();
    const b = await signUp();
    await follow(a.token, b.user.id);
    const p = (await createPost(b.token, 'bye')).body;
    expect((await req('DELETE', `/api/v1/posts/${p.id}`, { token: a.token })).status).toBe(403);
    const del = await req('DELETE', `/api/v1/posts/${p.id}`, { token: b.token });
    expect(del.status).toBe(204);
    expect((await feed(a.token)).items).toEqual([]);
    expect((await feed(b.token)).items).toEqual([]);
    const again = await req('DELETE', `/api/v1/posts/${p.id}`, { token: b.token });
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe('POST_NOT_FOUND');
    const [row] = await db.select().from(post).where(eqId(p.id));
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.version).toBe(2);
  });

  it('a non-uuid id is 404 POST_NOT_FOUND like every other post route', async () => {
    const a = await signUp();
    const r = await req('DELETE', '/api/v1/posts/not-a-uuid', { token: a.token });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('POST_NOT_FOUND');
  });
});

describe('create post', () => {
  it('replaying clientOpId returns the same post without duplicating', async () => {
    const a = await signUp();
    const b = await signUp();
    await follow(a.token, b.user.id);
    const clientOpId = randomUUID();
    const first = await createPost(b.token, 'once', { clientOpId });
    const second = await createPost(b.token, 'once', { clientOpId });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect((await feed(b.token)).items).toHaveLength(1);
    expect((await feed(a.token)).items).toHaveLength(1);
  });

  it('concurrent replays of one clientOpId create exactly one post', async () => {
    const b = await signUp();
    const clientOpId = randomUUID();
    const rs = await Promise.all([1, 2, 3].map(() => createPost(b.token, 'race', { clientOpId })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
  });

  it('replaying the clientOpId of a since-deleted post is 404 POST_NOT_FOUND', async () => {
    const b = await signUp();
    const clientOpId = randomUUID();
    const first = await createPost(b.token, 'gone soon', { clientOpId });
    expect(first.status).toBe(201);
    expect((await req('DELETE', `/api/v1/posts/${first.body.id}`, { token: b.token })).status).toBe(204);
    const replay = await createPost(b.token, 'gone soon', { clientOpId });
    expect(replay.status).toBe(404);
    expect(replay.body.error.code).toBe('POST_NOT_FOUND');
    expect((await feed(b.token)).items).toEqual([]);
  });

  it('validates text length', async () => {
    const { token } = await signUp();
    expect((await createPost(token, '')).status).toBe(400);
    expect((await createPost(token, 'x'.repeat(5001))).status).toBe(400);
  });
});

describe('users/:id/posts', () => {
  it('lists only that author, newest first, paginated', async () => {
    const a = await signUp();
    const b = await signUp();
    await createPost(a.token, 'mine');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.unshift((await createPost(b.token, `b${i}`)).body.id);
    const r1 = await req('GET', `/api/v1/users/${b.user.id}/posts?limit=2`, { token: a.token });
    expect(r1.body.items.map((i: any) => i.id)).toEqual(ids.slice(0, 2));
    const r2 = await req('GET', `/api/v1/users/${b.user.id}/posts?limit=2&cursor=${r1.body.nextCursor}`, { token: a.token });
    expect(r2.body.items.map((i: any) => i.id)).toEqual(ids.slice(2));
    expect(r2.body.nextCursor).toBeNull();
  });

  it('unknown user is 404 USER_NOT_FOUND, like followers/following', async () => {
    const a = await signUp();
    for (const id of ['no-such-user', randomUUID()]) {
      const r = await req('GET', `/api/v1/users/${id}/posts`, { token: a.token });
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('USER_NOT_FOUND');
    }
  });
});
