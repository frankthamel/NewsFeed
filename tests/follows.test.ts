import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { feedItem, post } from '../src/db/schema.js';
import { follow, req, resetDb, signUp } from './helpers.js';

beforeEach(resetDb);

const feedIds = async (token: string) => {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const r = await req('GET', `/api/v1/feed?limit=50${cursor ? `&cursor=${cursor}` : ''}`, { token });
    ids.push(...r.body.items.map((i: any) => i.id));
    cursor = r.body.nextCursor;
  } while (cursor);
  return ids;
};
const createPost = (token: string, text: string) =>
  req('POST', '/api/v1/posts', { token, json: { type: 'text', text } });

describe('follows', () => {
  it('backfills exactly the latest 50 posts on follow', async () => {
    const a = await signUp();
    const b = await signUp();
    const now = Date.now();
    const rows = Array.from({ length: 60 }, (_, i) => ({
      authorId: b.user.id,
      type: 'text' as const,
      text: `p${i}`,
      status: 'published' as const,
      createdAt: new Date(now - i * 1000),
      publishedAt: new Date(now - i * 1000),
    }));
    const inserted = await db.insert(post).values(rows).returning({ id: post.id, publishedAt: post.publishedAt });
    const latest50 = inserted
      .sort((x, y) => y.publishedAt!.getTime() - x.publishedAt!.getTime())
      .slice(0, 50)
      .map((p) => p.id);

    const r = await req('PUT', `/api/v1/users/${b.user.id}/follow`, { token: a.token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ following: true, followerCount: 1 });
    const ids = await feedIds(a.token);
    expect(ids).toHaveLength(50);
    expect(ids).toEqual(latest50);
  });

  it('unfollow removes followee posts but keeps own', async () => {
    const a = await signUp();
    const b = await signUp();
    await createPost(b.token, 'from b');
    const own = await createPost(a.token, 'mine');
    await follow(a.token, b.user.id);
    expect(await feedIds(a.token)).toHaveLength(2);
    const r = await req('DELETE', `/api/v1/users/${b.user.id}/follow`, { token: a.token });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ following: false, followerCount: 0 });
    expect(await feedIds(a.token)).toEqual([own.body.id]);
    const again = await req('DELETE', `/api/v1/users/${b.user.id}/follow`, { token: a.token });
    expect(again.status).toBe(200);
  });

  it('follow twice and concurrently is idempotent', async () => {
    const a = await signUp();
    const b = await signUp();
    await createPost(b.token, 'x');
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => req('PUT', `/api/v1/users/${b.user.id}/follow`, { token: a.token })),
    );
    for (const r of rs) {
      expect(r.status).toBe(200);
      expect(r.body.followerCount).toBe(1);
    }
    const again = await req('PUT', `/api/v1/users/${b.user.id}/follow`, { token: a.token });
    expect(again.body.followerCount).toBe(1);
    const rows = await db.select().from(feedItem).where(and(eq(feedItem.ownerId, a.user.id), eq(feedItem.authorId, b.user.id)));
    expect(rows).toHaveLength(1);
  });

  it('rejects self-follow and unknown users', async () => {
    const a = await signUp();
    const self = await req('PUT', `/api/v1/users/${a.user.id}/follow`, { token: a.token });
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe('CANNOT_FOLLOW_SELF');
    for (const m of ['PUT', 'DELETE']) {
      const r = await req(m, '/api/v1/users/nope/follow', { token: a.token });
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('USER_NOT_FOUND');
    }
    for (const l of ['followers', 'following']) {
      const r = await req('GET', `/api/v1/users/nope/${l}`, { token: a.token });
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('USER_NOT_FOUND');
    }
    expect((await req('PUT', `/api/v1/users/${a.user.id}/follow`)).status).toBe(401);
  });

  it('paginates followers and following; isFollowing is relative to caller', async () => {
    const target = await signUp();
    const viewer = await signUp();
    const followers = [];
    for (let i = 0; i < 25; i++) {
      const u = await signUp();
      followers.push(u);
      await follow(u.token, target.user.id);
    }
    await follow(viewer.token, followers[0]!.user.id);

    const seen: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await req('GET', `/api/v1/users/${target.user.id}/followers?limit=10${cursor ? `&cursor=${cursor}` : ''}`, {
        token: viewer.token,
      });
      expect(r.status).toBe(200);
      seen.push(...r.body.items);
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen.map((i) => i.id)).size).toBe(25);
    for (const i of seen) expect(i.isFollowing).toBe(i.id === followers[0]!.user.id);

    const first = await signUp();
    for (let i = 0; i < 3; i++) await follow(first.token, followers[i]!.user.id);
    const fl = await req('GET', `/api/v1/users/${first.user.id}/following?limit=2`, { token: viewer.token });
    expect(fl.body.items).toHaveLength(2);
    expect(fl.body.nextCursor).not.toBeNull();
    const fl2 = await req('GET', `/api/v1/users/${first.user.id}/following?limit=2&cursor=${fl.body.nextCursor}`, { token: viewer.token });
    expect(fl2.body.items).toHaveLength(1);
    const all = [...fl.body.items, ...fl2.body.items].map((i: any) => i.id);
    expect(new Set(all)).toEqual(new Set(followers.slice(0, 3).map((f) => f.user.id)));
    expect(fl2.body.nextCursor).toBeNull();
  });

  it('profile isFollowing true after follow', async () => {
    const a = await signUp();
    const b = await signUp();
    await follow(a.token, b.user.id);
    const r = await req('GET', `/api/v1/users/${b.user.id}`, { token: a.token });
    expect(r.body.isFollowing).toBe(true);
    expect(r.body.followerCount).toBe(1);
  });
});
