import { randomUUID } from 'node:crypto';
import { and, asc, eq, lt } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client.js';
import { media, post, uploadSession } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { deleteObjects, extFor, headObject, presignPut } from '../../lib/storage.js';
import { fanOutPost } from '../feed/fanout.js';
import type { FeedItem } from '../posts/schemas.js';
import { serializePosts } from '../posts/serialize.js';
import { UPLOAD_TTL_MS, validateFiles, type StartUploadBody } from './limits.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new AppError(404, 'UPLOAD_NOT_FOUND', 'Upload not found');

export async function startUpload(db: Db, userId: string, body: StartUploadBody) {
  validateFiles(body.type, body.files);
  await expireStaleUploads(db);

  const postId = randomUUID();
  const uploadId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + UPLOAD_TTL_MS);
  const rows = body.files.map((f, position) => {
    const id = randomUUID();
    return {
      id,
      postId,
      kind: f.kind,
      objectKey: `posts/${postId}/${id}.${extFor(f.contentType)}`,
      contentType: f.contentType,
      sizeBytes: f.sizeBytes,
      // Stored as declared; the columns are NOT NULL so an omitted dimension is 0.
      width: f.width ?? 0,
      height: f.height ?? 0,
      durationSec: f.durationSec ?? null,
      position,
    };
  });

  await db.transaction(async (tx) => {
    await tx.insert(post).values({
      id: postId,
      authorId: userId,
      type: body.type,
      text: body.text ?? null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(media).values(rows);
    await tx.insert(uploadSession).values({
      id: uploadId,
      ownerId: userId,
      postId,
      postType: body.type,
      status: 'open',
      expiresAt,
      createdAt: now,
    });
  });

  const uploads = await Promise.all(
    rows.map(async (row) => ({
      mediaId: row.id,
      kind: row.kind,
      position: row.position,
      ...(await presignPut(row.objectKey, row.contentType, row.sizeBytes)),
    })),
  );
  return { uploadId, postId, expiresAt: expiresAt.toISOString(), uploads };
}

async function loadOwnedSession(db: Db | Tx, userId: string, uploadId: string) {
  if (!UUID_RE.test(uploadId)) throw notFound();
  const [s] = await db.select().from(uploadSession).where(eq(uploadSession.id, uploadId));
  if (!s || s.ownerId !== userId) throw notFound();
  return s;
}

/**
 * Expire one session if it is still open and past its expiry: delete the pending post
 * (cascades to media and the session row). Returns the object keys to delete, or null if nothing happened.
 */
async function expireSession(db: Db, uploadId: string): Promise<string[] | null> {
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(uploadSession).where(eq(uploadSession.id, uploadId)).for('update');
    if (!s || s.status !== 'open' || s.expiresAt.getTime() >= Date.now()) return null;
    await tx.update(uploadSession).set({ status: 'expired' }).where(eq(uploadSession.id, uploadId));
    const keys = (await tx.select({ k: media.objectKey }).from(media).where(eq(media.postId, s.postId))).map((m) => m.k);
    await tx.delete(post).where(and(eq(post.id, s.postId), eq(post.status, 'pending')));
    return keys;
  });
}

export async function expireStaleUploads(db: Db): Promise<number> {
  const stale = await db
    .select({ id: uploadSession.id })
    .from(uploadSession)
    .where(and(eq(uploadSession.status, 'open'), lt(uploadSession.expiresAt, new Date())));
  let n = 0;
  const keys: string[] = [];
  for (const s of stale) {
    const k = await expireSession(db, s.id);
    if (k) {
      n++;
      keys.push(...k);
    }
  }
  await deleteObjects(keys);
  return n;
}

export async function completeUpload(db: Db, userId: string, uploadId: string): Promise<FeedItem> {
  const s = await loadOwnedSession(db, userId, uploadId);
  if (s.status === 'completed') return servePost(db, userId, s.postId);

  if (s.status === 'expired' || s.expiresAt.getTime() < Date.now()) {
    const keys = await expireSession(db, s.id);
    if (keys) await deleteObjects(keys);
    else {
      // Lost a race: it was completed meanwhile.
      const [again] = await db.select().from(uploadSession).where(eq(uploadSession.id, s.id));
      if (again?.status === 'completed') return servePost(db, userId, again.postId);
    }
    throw new AppError(410, 'UPLOAD_EXPIRED', 'Upload session expired');
  }

  const files = await db.select().from(media).where(eq(media.postId, s.postId)).orderBy(asc(media.position));
  const heads = await Promise.all(files.map((m) => headObject(m.objectKey)));
  const missing = files.filter((_, i) => !heads[i]).map((m) => m.id);
  if (missing.length > 0) {
    throw new AppError(409, 'UPLOAD_INCOMPLETE', 'Some files have not been uploaded', { missing });
  }
  const mismatched = files
    .filter((m, i) => heads[i]!.sizeBytes !== m.sizeBytes || heads[i]!.contentType !== m.contentType)
    .map((m) => m.id);
  if (mismatched.length > 0) {
    throw new AppError(422, 'MEDIA_MISMATCH', 'Uploaded files differ from what was declared', { mismatched });
  }

  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(uploadSession).where(eq(uploadSession.id, s.id)).for('update');
    if (!locked || locked.status !== 'open') return; // completed concurrently (or gone): re-checked below
    const now = new Date();
    await tx.update(media).set({ uploaded: true }).where(eq(media.postId, s.postId));
    await tx
      .update(post)
      .set({ status: 'published', publishedAt: now, updatedAt: now })
      .where(eq(post.id, s.postId));
    await tx.update(uploadSession).set({ status: 'completed' }).where(eq(uploadSession.id, s.id));
    await fanOutPost(tx, { id: s.postId, authorId: s.ownerId, publishedAt: now });
  });

  const [after] = await db.select().from(uploadSession).where(eq(uploadSession.id, s.id));
  if (!after || after.status !== 'completed') throw new AppError(410, 'UPLOAD_EXPIRED', 'Upload session expired');
  return servePost(db, userId, s.postId);
}

async function servePost(db: Db, userId: string, postId: string): Promise<FeedItem> {
  const [item] = await serializePosts(db, userId, [postId]);
  if (!item) throw new AppError(404, 'POST_NOT_FOUND', 'Post not found');
  return item;
}

export async function getUpload(db: Db, userId: string, uploadId: string) {
  const s = await loadOwnedSession(db, userId, uploadId);
  const files = await db.select().from(media).where(eq(media.postId, s.postId)).orderBy(asc(media.position));
  const heads = await Promise.all(files.map((m) => headObject(m.objectKey)));
  return {
    uploadId: s.id,
    postId: s.postId,
    status: s.status,
    expiresAt: s.expiresAt.toISOString(),
    media: files.map((m, i) => ({ mediaId: m.id, kind: m.kind, uploaded: heads[i] !== null })),
  };
}
