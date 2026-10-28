import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { like, post } from '../../db/schema.js';
import { clampClientTime } from '../../lib/time.js';
import type { OpOutcome, Operation } from './schemas.js';

type LikeOp = Extract<Operation, { type: 'like' | 'unlike' }>;

/**
 * Last-write-wins per (user, post). Caller must already hold the post row lock.
 * `likeCount` and `version` change only when `liked` actually flips.
 */
export async function applyLike(tx: Tx, userId: string, op: LikeOp): Promise<OpOutcome> {
  const ts = clampClientTime(op.clientTimestamp);
  const liked = op.type === 'like';

  const [row] = await tx
    .select()
    .from(like)
    .where(and(eq(like.postId, op.postId), eq(like.userId, userId)))
    .for('update');

  // Older than what we have → ignore. A tie is resolved by arrival order (the later op wins).
  if (row && ts.getTime() < row.clientUpdatedAt.getTime()) return { status: 'superseded' };

  const flipped = (row?.liked ?? false) !== liked;
  const now = new Date();
  // updatedAt doubles as "likedAt" for the likers list, so it moves only on a flip.
  const updatedAt = flipped || !row ? now : row.updatedAt;

  await tx
    .insert(like)
    .values({ postId: op.postId, userId, liked, clientUpdatedAt: ts, updatedAt })
    .onConflictDoUpdate({
      target: [like.postId, like.userId],
      set: { liked, clientUpdatedAt: ts, updatedAt },
    });

  if (flipped) {
    await tx
      .update(post)
      .set({
        likeCount: sql`${post.likeCount} + ${liked ? 1 : -1}`,
        version: sql`${post.version} + 1`,
        updatedAt: now,
      })
      .where(eq(post.id, op.postId));
  }
  return { status: 'applied' };
}
