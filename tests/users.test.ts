import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { follow } from '../src/db/schema.js';
import { publicUrl } from '../src/lib/storage.js';
import { req, resetDb, signUp } from './helpers.js';

beforeEach(resetDb);

describe('user profiles', () => {
  it("shows another user's profile with zero counts", async () => {
    const a = await signUp();
    const b = await signUp({ name: 'Bob', username: 'bob' });
    const r = await req('GET', `/api/v1/users/${b.user.id}`, { token: a.token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: b.user.id,
      username: 'bob',
      displayName: 'Bob',
      followerCount: 0,
      followingCount: 0,
      postCount: 0,
      isFollowing: false,
    });
  });

  it('reports isFollowing and counts', async () => {
    const a = await signUp();
    const b = await signUp();
    await db.insert(follow).values({ followerId: a.user.id, followeeId: b.user.id });
    const r = await req('GET', `/api/v1/users/${b.user.id}`, { token: a.token });
    expect(r.body).toMatchObject({ isFollowing: true, followerCount: 1 });
    const self = await req('GET', `/api/v1/users/${a.user.id}`, { token: a.token });
    expect(self.body).toMatchObject({ isFollowing: false, followingCount: 1 });
  });

  it('404 USER_NOT_FOUND for unknown id', async () => {
    const a = await signUp();
    const r = await req('GET', '/api/v1/users/nope', { token: a.token });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('USER_NOT_FOUND');
  });

  it('requires auth', async () => {
    expect((await req('GET', '/api/v1/users/x')).status).toBe(401);
  });

  it('PATCH /me updates displayName and bio', async () => {
    const a = await signUp();
    const r = await req('PATCH', '/api/v1/me', { token: a.token, json: { displayName: 'New Name', bio: 'hello' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ displayName: 'New Name', bio: 'hello' });
    const cleared = await req('PATCH', '/api/v1/me', { token: a.token, json: { bio: null } });
    expect(cleared.body.bio).toBeNull();
    expect(cleared.body.displayName).toBe('New Name');
  });

  it('PATCH /me rejects an invalid username', async () => {
    const a = await signUp();
    const r = await req('PATCH', '/api/v1/me', { token: a.token, json: { username: 'A B' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(r.body.error.details).toBeDefined();
  });

  it('PATCH /me to a taken username is 409 ID_CONFLICT', async () => {
    const a = await signUp({ username: 'taken_one' });
    const b = await signUp();
    const r = await req('PATCH', '/api/v1/me', { token: b.token, json: { username: 'taken_one' } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ID_CONFLICT');
    const ok = await req('PATCH', '/api/v1/me', { token: a.token, json: { username: 'renamed' } });
    expect(ok.body.username).toBe('renamed');
  });
});

describe('avatar', () => {
  async function uploadAvatar(token: string, size = 321) {
    const up = await req('POST', '/api/v1/me/avatar/upload-url', {
      token,
      json: { contentType: 'image/png', sizeBytes: size },
    });
    expect(up.status).toBe(200);
    return up.body as { avatarKey: string; url: string; method: string; headers: Record<string, string> };
  }

  it('upload-url -> PUT -> complete sets avatarUrl', async () => {
    const a = await signUp();
    const up = await uploadAvatar(a.token);
    expect(up.avatarKey).toMatch(new RegExp(`^avatars/${a.user.id}/[0-9a-f-]+\\.png$`));
    const put = await fetch(up.url, { method: up.method, headers: up.headers, body: Buffer.alloc(321, 7) });
    expect(put.status).toBe(200);
    const done = await req('POST', '/api/v1/me/avatar/complete', { token: a.token, json: { avatarKey: up.avatarKey } });
    expect(done.status).toBe(200);
    expect(done.body.avatarUrl).toBe(publicUrl(up.avatarKey));
    expect((await fetch(done.body.avatarUrl)).status).toBe(200);
  });

  it('rejects non-image types and oversize', async () => {
    const a = await signUp();
    const t = await req('POST', '/api/v1/me/avatar/upload-url', { token: a.token, json: { contentType: 'video/mp4', sizeBytes: 10 } });
    expect(t.status).toBe(400);
    const s = await req('POST', '/api/v1/me/avatar/upload-url', { token: a.token, json: { contentType: 'image/png', sizeBytes: 10_485_761 } });
    expect(s.status).toBe(400);
  });

  it("complete with another user's key is 403 FORBIDDEN", async () => {
    const a = await signUp();
    const b = await signUp();
    const up = await uploadAvatar(a.token);
    const r = await req('POST', '/api/v1/me/avatar/complete', { token: b.token, json: { avatarKey: up.avatarKey } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
  });

  it('complete before upload is 409 UPLOAD_INCOMPLETE', async () => {
    const a = await signUp();
    const up = await uploadAvatar(a.token);
    const r = await req('POST', '/api/v1/me/avatar/complete', { token: a.token, json: { avatarKey: up.avatarKey } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('UPLOAD_INCOMPLETE');
  });
});

describe('user search', () => {
  it('prefix-matches username or name case-insensitively, excluding the caller', async () => {
    const me = await signUp({ username: 'anna_me', name: 'Anna Me' });
    await signUp({ username: 'ann', name: 'Ann' });
    await signUp({ username: 'handy', name: 'Andy' });
    await signUp({ username: 'zed', name: 'Zed' });
    const r = await req('GET', '/api/v1/users?search=an', { token: me.token });
    expect(r.status).toBe(200);
    const names = r.body.items.map((u: any) => u.displayName).sort();
    expect(names).toEqual(['Andy', 'Ann']);
    expect(r.body.nextCursor).toBeNull();
    expect(Object.keys(r.body.items[0]).sort()).toEqual(['avatarUrl', 'displayName', 'id', 'username']);
  });

  it('treats % and _ literally', async () => {
    const me = await signUp();
    await signUp({ username: 'abc', name: 'Abc' });
    const r = await req('GET', '/api/v1/users?search=%25', { token: me.token });
    expect(r.body.items).toEqual([]);
  });

  it('paginates 25 users with no duplicates or gaps', async () => {
    const me = await signUp({ username: 'viewer', name: 'Viewer' });
    const expected = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const u = await signUp({ username: `page_user_${i}`, name: `Page User ${i}` });
      expected.add(u.user.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `/api/v1/users?search=page&limit=10${cursor ? `&cursor=${cursor}` : ''}`;
      const r = await req('GET', q, { token: me.token });
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((u: any) => u.id));
      cursor = r.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(25);
    expect(new Set(seen)).toEqual(expected);
  });

  it('invalid cursor is 400 INVALID_CURSOR', async () => {
    const me = await signUp();
    const r = await req('GET', '/api/v1/users?search=a&cursor=!!!', { token: me.token });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_CURSOR');
  });
});
