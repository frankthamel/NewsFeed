import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { feedItem, follow, post } from '../../db/schema.js';

/** Insert a feed_item for the author and every follower. */
export async function fanOutPost(
  tx: Tx,
  p: { id: string; authorId: string; publishedAt: Date },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO feed_item (owner_id, post_id, author_id, created_at)
    SELECT ${p.authorId}, ${p.id}::uuid, ${p.authorId}, ${p.publishedAt.toISOString()}::timestamptz
    UNION
    SELECT follower_id, ${p.id}::uuid, ${p.authorId}, ${p.publishedAt.toISOString()}::timestamptz
    FROM follow WHERE followee_id = ${p.authorId}
    ON CONFLICT DO NOTHING
  `);
}

/** Copy the followee's latest 50 published, non-deleted posts into the follower's feed. */
export async function backfillFeed(tx: Tx, followerId: string, followeeId: string): Promise<void> {
  const latest = await tx
    .select({ id: post.id, publishedAt: post.publishedAt })
    .from(post)
    .where(and(eq(post.authorId, followeeId), eq(post.status, 'published'), isNull(post.deletedAt)))
    .orderBy(desc(post.publishedAt), desc(post.id))
    .limit(50);
  if (latest.length === 0) return;
  await tx
    .insert(feedItem)
    .values(
      latest.map((p) => ({
        ownerId: followerId,
        postId: p.id,
        authorId: followeeId,
        createdAt: p.publishedAt!,
      })),
    )
    .onConflictDoNothing();
}

export async function removeFromFeed(tx: Tx, followerId: string, authorId: string): Promise<void> {
  await tx.delete(feedItem).where(and(eq(feedItem.ownerId, followerId), eq(feedItem.authorId, authorId)));
}

export async function removePostFromFeeds(tx: Tx, postId: string): Promise<void> {
  await tx.delete(feedItem).where(eq(feedItem.postId, postId));
}
