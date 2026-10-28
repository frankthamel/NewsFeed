import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { feedItem } from '../../db/schema.js';
import { toPage } from '../../lib/cursor.js';
import { serializePosts } from '../posts/serialize.js';
import { decodeUuidCursor } from '../posts/service.js';

export async function getFeed(db: Db, viewerId: string, q: { cursor?: string; limit: number }) {
  const conds = [eq(feedItem.ownerId, viewerId)];
  if (q.cursor) {
    const c = decodeUuidCursor(q.cursor);
    conds.push(sql`(${feedItem.createdAt}, ${feedItem.postId}) < (${c.t}::timestamptz, ${c.id}::uuid)`);
  }
  const rows = await db
    .select({ postId: feedItem.postId, createdAt: feedItem.createdAt })
    .from(feedItem)
    .where(and(...conds))
    .orderBy(sql`${feedItem.createdAt} desc`, sql`${feedItem.postId} desc`)
    .limit(q.limit + 1);
  const page = toPage(rows, q.limit, (r) => ({ t: r.createdAt.toISOString(), id: r.postId }));
  return { items: await serializePosts(db, viewerId, page.items.map((r) => r.postId)), nextCursor: page.nextCursor };
}
