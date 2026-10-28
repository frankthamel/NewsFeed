import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { clientOperation, post } from '../../db/schema.js';
import { decodeCursor, toPage, type Cursor } from '../../lib/cursor.js';
import { AppError } from '../../lib/errors.js';
import { fanOutPost, removePostFromFeeds } from '../feed/fanout.js';
import type { FeedItem } from './schemas.js';
import { serializePosts } from './serialize.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decode a cursor whose id is compared against a uuid column. */
export function decodeUuidCursor(s: string): Cursor {
  const c = decodeCursor(s);
  if (!UUID_RE.test(c.id)) throw new AppError(400, 'INVALID_CURSOR', 'Invalid cursor');
  return c;
}

export async function createTextPost(
  db: Db,
  userId: string,
  input: { text: string; clientOpId?: string },
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
    const publishedAt = new Date();
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
