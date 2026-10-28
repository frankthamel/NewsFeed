import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { comment, like, post } from '../src/db/schema.js';
import { encodeCursor } from '../src/lib/cursor.js';
import { follow, req, resetDb, signUp } from './helpers.js';

beforeEach(resetDb);

const createPost = async (token: string, text = 'hi') =>
  (await req('POST', '/api/v1/posts', { token, json: { type: 'text', text } })).body.id as string;

const BASE = Date.parse('2026-01-01T00:00:00.000Z');

describe('post detail', () => {
  it('shows author counts relative to viewer', async () => {
    const author = await signUp();
    const viewer = await signUp();
    const other = await signUp();
    await follow(viewer.token, author.user.id);
    await follow(other.token, author.user.id);
    const id = await createPost(author.token);

    const v = await req('GET', `/api/v1/posts/${id}`, { token: viewer.token });
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ id, text: 'hi', likedByMe: false });
    expect(v.body.author).toMatchObject({ id: author.user.id, followerCount: 2, isFollowing: true });

    const self = await req('GET', `/api/v1/posts/${id}`, { token: author.token });
    expect(self.body.author).toMatchObject({ followerCount: 2, isFollowing: false });

    const stranger = await signUp();
    const s = await req('GET', `/api/v1/posts/${id}`, { token: stranger.token });
    expect(s.body.author.isFollowing).toBe(false);
  });

  it('404 for deleted, pending, unknown and non-uuid ids on all three routes', async () => {
    const a = await signUp();
    const id = await createPost(a.token);
    await req('DELETE', `/api/v1/posts/${id}`, { token: a.token });
    const pending = randomUUID();
    await db.insert(post).values({ id: pending, authorId: a.user.id, type: 'image', status: 'pending' });
    for (const pid of [id, pending, randomUUID(), 'not-a-uuid']) {
      for (const suffix of ['', '/comments', '/likes']) {
        const r = await req('GET', `/api/v1/posts/${pid}${suffix}`, { token: a.token });
        expect(r.status).toBe(404);
        expect(r.body.error.code).toBe('POST_NOT_FOUND');
      }
    }
  });

  it('requires auth', async () => {
    const r = await req('GET', `/api/v1/posts/${randomUUID()}`);
    expect(r.status).toBe(401);
  });
});

describe('comments list', () => {
  it('paginates oldest-first without duplicates and excludes deleted', async () => {
    const a = await signUp();
    const id = await createPost(a.token);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const cid = randomUUID();
      ids.push(cid);
      await db.insert(comment).values({
        id: cid,
        postId: id,
        authorId: a.user.id,
        text: `c${i}`,
        clientCreatedAt: new Date(BASE + i * 1000),
        createdAt: new Date(BASE + i * 1000),
        updatedAt: new Date(BASE + i * 1000),
      });
    }
    await db.update(comment).set({ deletedAt: new Date() }).where(eq(comment.id, ids[3]!));
    const expected = ids.filter((_, i) => i !== 3);

    const collected: string[] = [];
    let r = await req('GET', `/api/v1/posts/${id}/comments?limit=10`, { token: a.token });
    expect(r.status).toBe(200);
    collected.push(...r.body.items.map((c: any) => c.id));
    expect(r.body.items[0]).toMatchObject({ postId: id, text: 'c0', edited: false, author: { id: a.user.id } });
    while (r.body.nextCursor) {
      r = await req('GET', `/api/v1/posts/${id}/comments?limit=10&cursor=${r.body.nextCursor}`, { token: a.token });
      collected.push(...r.body.items.map((c: any) => c.id));
    }
    expect(collected).toEqual(expected);
  });

  it('bad cursors return 400 INVALID_CURSOR', async () => {
    const a = await signUp();
    const id = await createPost(a.token);
    for (const cursor of ['bogus', encodeCursor({ t: new Date().toISOString(), id: 'not-a-uuid' })]) {
      const r = await req('GET', `/api/v1/posts/${id}/comments?cursor=${cursor}`, { token: a.token });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_CURSOR');
    }
  });
});

describe('likers list', () => {
  it('lists only liked=true users, newest first, with pagination', async () => {
    const a = await signUp();
    const id = await createPost(a.token);
    const users = [await signUp(), await signUp(), await signUp(), await signUp()];
    for (const [i, u] of users.entries()) {
      await db.insert(like).values({
        postId: id,
        userId: u.user.id,
        liked: i !== 1,
        clientUpdatedAt: new Date(BASE + i * 1000),
        updatedAt: new Date(BASE + i * 1000),
      });
    }
    const r = await req('GET', `/api/v1/posts/${id}/likes?limit=2`, { token: a.token });
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: any) => x.id)).toEqual([users[3]!.user.id, users[2]!.user.id]);
    expect(r.body.items[0].likedAt).toBe(new Date(BASE + 3000).toISOString());
    expect(r.body.items[0].username).toBe(users[3]!.user.username);
    const r2 = await req('GET', `/api/v1/posts/${id}/likes?limit=2&cursor=${r.body.nextCursor}`, { token: a.token });
    expect(r2.body.items.map((x: any) => x.id)).toEqual([users[0]!.user.id]);
    expect(r2.body.nextCursor).toBeNull();

    const bad = await req('GET', `/api/v1/posts/${id}/likes?cursor=bogus`, { token: a.token });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_CURSOR');
  });
});
