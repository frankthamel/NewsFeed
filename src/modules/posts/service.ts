import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { clientOperation, comment, like, post, user } from '../../db/schema.js';
import { decodeCursor, toPage, type Cursor } from '../../lib/cursor.js';
import { AppError } from '../../lib/errors.js';
import { isUuid } from '../../lib/uuid.js';
import { fanOutPost, removePostFromFeeds } from '../feed/fanout.js';
import { getUserProfile, getUserSummaries } from '../users/service.js';
import type { FeedItem, PostDetail } from './schemas.js';
import { serializePosts, toComment } from './serialize.js';

/** Decode a cursor whose id is compared against a uuid column. */
export function decodeUuidCursor(s: string): Cursor {
  const c = decodeCursor(s);
  if (!isUuid(c.id)) throw new AppError(400, 'INVALID_CURSOR', 'Invalid cursor');
  return c;
}

export async function createTextPost(
  db: Db,
  userId: string,
  input: { text: string; clientOpId?: string },
  options?: { now?: Date },
): Promise<{ post: FeedItem; created: boolean }> {
  const postId = await db.transaction(async (tx) => {
    const id = randomUUID();
    if (input.clientOpId) {
      const inserted = await tx
        .insert(clientOperation)
        .values({ userId, opId: input.clientOpId, type: 'create_post', outcome: 'applied', postId: id })
        .onConflictDoNothing()
        .returning({ opId: clientOperation.opId });
      if (inserted.length === 0) {
        const [existing] = await tx
          .select({ postId: clientOperation.postId })
          .from(clientOperation)
          .where(and(eq(clientOperation.userId, userId), eq(clientOperation.opId, input.clientOpId)));
        return { id: existing?.postId ?? null, created: false };
      }
    }
    const publishedAt = options?.now ?? new Date();
    await tx.insert(post).values({
      id,
      authorId: userId,
      type: 'text',
      text: input.text,
      status: 'published',
      createdAt: publishedAt,
      publishedAt,
      updatedAt: publishedAt,
    });
    await fanOutPost(tx, { id, authorId: userId, publishedAt });
    return { id, created: true };
  });

  if (!postId.id) throw new AppError(404, 'POST_NOT_FOUND', 'Post not found');
  const [item] = await serializePosts(db, userId, [postId.id]);
  if (!item) throw new AppError(404, 'POST_NOT_FOUND', 'Post not found');
  return { post: item, created: postId.created };
}

export async function deletePost(db: Db, userId: string, postId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(post).where(eq(post.id, postId)).for('update');
    if (!p || p.deletedAt || p.status !== 'published') {
      throw new AppError(404, 'POST_NOT_FOUND', 'Post not found');
    }
    if (p.authorId !== userId) throw new AppError(403, 'FORBIDDEN', 'Only the author can delete this post');
    const now = new Date();
    await tx
      .update(post)
      .set({ deletedAt: now, updatedAt: now, version: sql`${post.version} + 1` })
      .where(eq(post.id, postId));
    await removePostFromFeeds(tx, postId);
  });
}

export async function listUserPosts(
  db: Db,
  viewerId: string,
  authorId: string,
  q: { cursor?: string; limit: number },
) {
  const conds = [eq(post.authorId, authorId), eq(post.status, 'published'), isNull(post.deletedAt)];
  if (q.cursor) {
    const c = decodeUuidCursor(q.cursor);
    conds.push(sql`(${post.publishedAt}, ${post.id}) < (${c.t}::timestamptz, ${c.id}::uuid)`);
  }
  const rows = await db
    .select({ id: post.id, publishedAt: post.publishedAt })
    .from(post)
    .where(and(...conds))
    .orderBy(sql`${post.publishedAt} desc`, sql`${post.id} desc`)
    .limit(q.limit + 1);
  const page = toPage(rows, q.limit, (r) => ({ t: r.publishedAt!.toISOString(), id: r.id }));
  return { items: await serializePosts(db, viewerId, page.items.map((r) => r.id)), nextCursor: page.nextCursor };
}

async function assertPostVisible(db: Db, postId: string): Promise<void> {
  if (!isUuid(postId)) throw new AppError(404, 'POST_NOT_FOUND', 'Post not found');
  const [p] = await db
    .select({ id: post.id })
    .from(post)
    .where(and(eq(post.id, postId), eq(post.status, 'published'), isNull(post.deletedAt)));
  if (!p) throw new AppError(404, 'POST_NOT_FOUND', 'Post not found');
}

export async function getPostDetail(db: Db, viewerId: string, postId: string): Promise<PostDetail> {
  if (!isUuid(postId)) throw new AppError(404, 'POST_NOT_FOUND', 'Post not found');
  const [item] = await serializePosts(db, viewerId, [postId]);
  if (!item) throw new AppError(404, 'POST_NOT_FOUND', 'Post not found');
  const profile = await getUserProfile(db, viewerId, item.author.id);
  return {
    ...item,
    author: { ...item.author, followerCount: profile.followerCount, isFollowing: profile.isFollowing },
  };
}

export async function listComments(
  db: Db,
  postId: string,
  q: { cursor?: string; limit: number },
) {
  await assertPostVisible(db, postId);
  const conds = [eq(comment.postId, postId), isNull(comment.deletedAt)];
  if (q.cursor) {
    const c = decodeUuidCursor(q.cursor);
    conds.push(sql`(${comment.createdAt}, ${comment.id}) > (${c.t}::timestamptz, ${c.id}::uuid)`);
  }
  const rows = await db
    .select()
    .from(comment)
    .where(and(...conds))
    .orderBy(sql`${comment.createdAt} asc`, sql`${comment.id} asc`)
    .limit(q.limit + 1);
  const page = toPage(rows, q.limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }));
  const users = await getUserSummaries(db, page.items.map((r) => r.authorId));
  const items = page.items.flatMap((r) => {
    const author = users.get(r.authorId);
    return author ? [toComment(r, author)] : [];
  });
  return { items, nextCursor: page.nextCursor };
}

export async function listLikers(
  db: Db,
  postId: string,
  q: { cursor?: string; limit: number },
) {
  await assertPostVisible(db, postId);
  const conds = [eq(like.postId, postId), eq(like.liked, true)];
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    conds.push(sql`(${like.updatedAt}, ${like.userId}) < (${c.t}::timestamptz, ${c.id})`);
  }
  const rows = await db
    .select({ userId: like.userId, updatedAt: like.updatedAt })
    .from(like)
    .innerJoin(user, eq(user.id, like.userId))
    .where(and(...conds))
    .orderBy(sql`${like.updatedAt} desc`, sql`${like.userId} desc`)
    .limit(q.limit + 1);
  const page = toPage(rows, q.limit, (r) => ({ t: r.updatedAt.toISOString(), id: r.userId }));
  const users = await getUserSummaries(db, page.items.map((r) => r.userId));
  const items = page.items.flatMap((r) => {
    const u = users.get(r.userId);
    return u ? [{ ...u, likedAt: r.updatedAt.toISOString() }] : [];
  });
  return { items, nextCursor: page.nextCursor };
}

/** Compare client-cached versions with the server: changed posts come back whole, gone ones by id. */
export async function refreshPosts(
  db: Db,
  viewerId: string,
  posts: { id: string; version: number }[],
): Promise<{ updated: FeedItem[]; deleted: string[] }> {
  // Dedupe by id, keeping the first occurrence.
  const sent = new Map<string, number>();
  for (const p of posts) if (!sent.has(p.id)) sent.set(p.id, p.version);

  const validIds = [...sent.keys()].filter(isUuid);
  const live = new Map<string, number>();
  if (validIds.length > 0) {
    const rows = await db
      .select({ id: post.id, version: post.version })
      .from(post)
      .where(and(inArray(post.id, validIds), eq(post.status, 'published'), isNull(post.deletedAt)));
    for (const r of rows) live.set(r.id, r.version);
  }

  const deleted: string[] = [];
  const changed: string[] = [];
  for (const [id, version] of sent) {
    const serverVersion = live.get(id);
    if (serverVersion === undefined) deleted.push(id);
    else if (serverVersion !== version) changed.push(id);
  }
  return { updated: await serializePosts(db, viewerId, changed), deleted };
}
