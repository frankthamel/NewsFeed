import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { media, post, uploadSession } from '../src/db/schema.js';
import { follow, putObjectRaw, req, resetDb, signUp, uploadFiles } from './helpers.js';

const img = (n = 100) => ({ kind: 'image', contentType: 'image/jpeg', sizeBytes: n, width: 10, height: 10 });
const start = (token: string, json: unknown) => req('POST', '/api/v1/posts/uploads', { token, json });
const complete = (token: string, id: string) => req('POST', `/api/v1/posts/uploads/${id}/complete`, { token });
const feed = async (token: string) => (await req('GET', '/api/v1/feed', { token })).body.items as any[];

beforeEach(resetDb);

describe('media uploads', () => {
  it('image post with 3 images: start, PUT, complete, fan-out', async () => {
    const author = await signUp();
    const fan = await signUp();
    await follow(fan.token, author.user.id);
    const s = await start(author.token, { type: 'image', text: 'hi', files: [img(100), img(200), img(300)] });
    expect(s.status).toBe(201);
    expect(s.body.uploads).toHaveLength(3);
    expect(s.body.uploads[0]).toMatchObject({ kind: 'image', position: 0, method: 'PUT' });
    expect(await feed(author.token)).toHaveLength(0);
    expect(await feed(fan.token)).toHaveLength(0);
    await uploadFiles(s.body, [Buffer.alloc(100, 1), Buffer.alloc(200, 1), Buffer.alloc(300, 1)]);
    const c = await complete(author.token, s.body.uploadId);
    expect(c.status).toBe(200);
    expect(c.body.id).toBe(s.body.postId);
    expect(c.body.type).toBe('image');
    expect(c.body.media.map((m: any) => m.position)).toEqual([0, 1, 2]);
    expect(c.body.media.map((m: any) => m.sizeBytes)).toEqual([100, 200, 300]);
    for (const m of c.body.media) expect((await fetch(m.url)).status).toBe(200);
    expect((await feed(fan.token)).map((i) => i.id)).toEqual([s.body.postId]);
    expect(await feed(author.token)).toHaveLength(1);
  });

  it('video post with thumbnail', async () => {
    const a = await signUp();
    const s = await start(a.token, {
      type: 'video',
      files: [
        { kind: 'video', contentType: 'video/mp4', sizeBytes: 500, width: 10, height: 10, durationSec: 3 },
        { kind: 'thumbnail', contentType: 'image/jpeg', sizeBytes: 50, width: 10, height: 10 },
      ],
    });
    expect(s.status).toBe(201);
    await uploadFiles(s.body, [Buffer.alloc(500, 1), Buffer.alloc(50, 1)]);
    const c = await complete(a.token, s.body.uploadId);
    expect(c.status).toBe(200);
    expect(c.body.text).toBeNull();
    expect(c.body.media.map((m: any) => m.kind)).toEqual(['video', 'thumbnail']);
  });

  it('missing file -> 409 naming it, then succeeds after upload', async () => {
    const a = await signUp();
    const s = await start(a.token, { type: 'image', files: [img(10), img(20)] });
    await uploadFiles(s.body, [Buffer.alloc(10, 1), null]);
    const c = await complete(a.token, s.body.uploadId);
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('UPLOAD_INCOMPLETE');
    expect(c.body.error.details.missing).toEqual([s.body.uploads[1].mediaId]);
    expect(await feed(a.token)).toHaveLength(0);
    await uploadFiles(s.body, [null, Buffer.alloc(20, 1)]);
    expect((await complete(a.token, s.body.uploadId)).status).toBe(200);
  });

  it('declared thumbnail never uploaded -> 409', async () => {
    const a = await signUp();
    const s = await start(a.token, {
      type: 'video',
      files: [
        { kind: 'video', contentType: 'video/mp4', sizeBytes: 500, width: 1, height: 1 },
        { kind: 'thumbnail', contentType: 'image/png', sizeBytes: 50, width: 1, height: 1 },
      ],
    });
    await uploadFiles(s.body, [Buffer.alloc(500, 1), null]);
    const c = await complete(a.token, s.body.uploadId);
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('UPLOAD_INCOMPLETE');
    expect(c.body.error.details.missing).toEqual([s.body.uploads[1].mediaId]);
  });

  it('wrong content-type or size -> 422 MEDIA_MISMATCH, stays unpublished', async () => {
    const a = await signUp();
    const s = await start(a.token, { type: 'image', files: [img(10), img(20), img(30)] });
    const keyOf = async (i: number) =>
      (await db.select().from(media).where(eq(media.id, s.body.uploads[i].mediaId)))[0]!.objectKey;
    await putObjectRaw(await keyOf(0), 'image/png', Buffer.alloc(10, 1)); // wrong type
    await putObjectRaw(await keyOf(1), 'image/jpeg', Buffer.alloc(21, 1)); // wrong size
    await putObjectRaw(await keyOf(2), 'image/jpeg', Buffer.alloc(30, 1)); // ok
    const c = await complete(a.token, s.body.uploadId);
    expect(c.status).toBe(422);
    expect(c.body.error.code).toBe('MEDIA_MISMATCH');
    expect(c.body.error.details.mismatched.sort()).toEqual([s.body.uploads[0].mediaId, s.body.uploads[1].mediaId].sort());
    const [p] = await db.select().from(post).where(eq(post.id, s.body.postId));
    expect(p!.status).toBe('pending');
    const [sess] = await db.select().from(uploadSession).where(eq(uploadSession.id, s.body.uploadId));
    expect(sess!.status).toBe('open');
  });

  it('missing is reported before mismatch', async () => {
    const a = await signUp();
    const s = await start(a.token, { type: 'image', files: [img(10), img(20)] });
    const key = (await db.select().from(media).where(eq(media.id, s.body.uploads[0].mediaId)))[0]!.objectKey;
    await putObjectRaw(key, 'image/png', Buffer.alloc(10, 1));
    const c = await complete(a.token, s.body.uploadId);
    expect(c.status).toBe(409);
  });

  it('complete twice -> same post, one feed item', async () => {
    const a = await signUp();
    const s = await start(a.token, { type: 'image', files: [img(10)] });
    await uploadFiles(s.body, [Buffer.alloc(10, 1)]);
    const c1 = await complete(a.token, s.body.uploadId);
    const c2 = await complete(a.token, s.body.uploadId);
    expect([c1.status, c2.status]).toEqual([200, 200]);
    expect(c2.body.id).toBe(c1.body.id);
    expect(await feed(a.token)).toHaveLength(1);
  });

  it('concurrent complete -> one publish, one fan-out', async () => {
    const a = await signUp();
    const fan = await signUp();
    await follow(fan.token, a.user.id);
    const s = await start(a.token, { type: 'image', files: [img(10)] });
    await uploadFiles(s.body, [Buffer.alloc(10, 1)]);
    const [r1, r2] = await Promise.all([complete(a.token, s.body.uploadId), complete(a.token, s.body.uploadId)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(r1.body.id).toBe(r2.body.id);
    expect(await feed(fan.token)).toHaveLength(1);
    expect(await feed(a.token)).toHaveLength(1);
  });

  it('expired session -> 410 and post gone', async () => {
    const a = await signUp();
    const s = await start(a.token, { type: 'image', files: [img(10)] });
    await uploadFiles(s.body, [Buffer.alloc(10, 1)]);
    await db.update(uploadSession).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(uploadSession.id, s.body.uploadId));
    const c = await complete(a.token, s.body.uploadId);
    expect(c.status).toBe(410);
    expect(c.body.error.code).toBe('UPLOAD_EXPIRED');
    expect(await db.select().from(post).where(eq(post.id, s.body.postId))).toHaveLength(0);
    expect((await complete(a.token, s.body.uploadId)).status).toBe(404);
  });

  it('starting an upload lazily expires stale sessions', async () => {
    const a = await signUp();
    const s = await start(a.token, { type: 'image', files: [img(10)] });
    await db.update(uploadSession).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(uploadSession.id, s.body.uploadId));
    expect((await start(a.token, { type: 'image', files: [img(10)] })).status).toBe(201);
    expect(await db.select().from(post).where(eq(post.id, s.body.postId))).toHaveLength(0);
  });

  it('validation', async () => {
    const a = await signUp();
    expect((await start(a.token, { type: 'image', files: Array.from({ length: 11 }, () => img()) })).status).toBe(400);
    expect((await start(a.token, { type: 'image', files: [img(10_485_761)] })).status).toBe(400);
    expect((await start(a.token, { type: 'image', files: [img(10_485_760)] })).status).toBe(201);
    const vid = { kind: 'video', contentType: 'video/mp4', sizeBytes: 10, width: 1, height: 1 };
    expect((await start(a.token, { type: 'video', files: [vid, vid] })).status).toBe(400);
    expect((await start(a.token, { type: 'video', files: [{ ...vid, sizeBytes: 104_857_601 }] })).status).toBe(400);
    expect((await start(a.token, { type: 'image', files: [{ ...img(), contentType: 'image/gif' }] })).status).toBe(400);
    expect((await start(a.token, { type: 'image', files: [] })).status).toBe(400);
    expect((await start(a.token, { type: 'video', files: [vid, img()] })).status).toBe(400);
  });

  it("another user's or unknown or non-uuid upload -> 404", async () => {
    const a = await signUp();
    const b = await signUp();
    const s = await start(a.token, { type: 'image', files: [img(10)] });
    for (const id of [s.body.uploadId, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const c = await complete(b.token, id);
      expect(c.status).toBe(404);
      expect(c.body.error.code).toBe('UPLOAD_NOT_FOUND');
      expect((await req('GET', `/api/v1/posts/uploads/${id}`, { token: b.token })).status).toBe(404);
    }
  });

  it('GET upload reports uploaded per media', async () => {
    const a = await signUp();
    const s = await start(a.token, { type: 'image', files: [img(10), img(20)] });
    await uploadFiles(s.body, [Buffer.alloc(10, 1), null]);
    const g = await req('GET', `/api/v1/posts/uploads/${s.body.uploadId}`, { token: a.token });
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ uploadId: s.body.uploadId, postId: s.body.postId, status: 'open' });
    expect(g.body.media.map((m: any) => m.uploaded)).toEqual([true, false]);
  });

  it('requires auth', async () => {
    expect((await req('POST', '/api/v1/posts/uploads', { json: {} })).status).toBe(401);
  });
});
