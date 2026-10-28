import { count, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { post, user } from '../src/db/schema.js';
import { seed } from '../scripts/seed.js';
import { req, resetDb } from './helpers.js';

describe('seed', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('creates demo users, posts and a working feed', async () => {
    const summary = await seed({ users: 4, postsPerUser: 3, reset: false });
    expect(summary.users).toBe(4);

    const [{ n: users }] = await db.select({ n: count() }).from(user);
    expect(users).toBe(4);
    const [{ n: posts }] = await db.select({ n: count() }).from(post).where(eq(post.status, 'published'));
    expect(posts).toBe(12);

    const signIn = await req('POST', '/api/auth/sign-in/email', {
      json: { email: 'demo1@newsfeed.dev', password: 'password123' },
    });
    expect(signIn.status).toBe(200);
    const token = signIn.headers.get('set-auth-token')!;

    const feed = await req('GET', '/api/v1/feed?limit=50', { token });
    expect(feed.status).toBe(200);
    expect(feed.body.items.length).toBeGreaterThan(0);

    const withImage = feed.body.items.find((p: any) => p.type === 'image' && p.media.length > 0);
    expect(withImage).toBeDefined();
    const res = await fetch(withImage.media[0].url);
    expect(res.status).toBe(200);
  });

  it('refuses to seed over existing demo users', async () => {
    await expect(seed({ users: 2, postsPerUser: 1, reset: false })).rejects.toThrow(/demo users exist/);
  });
});
