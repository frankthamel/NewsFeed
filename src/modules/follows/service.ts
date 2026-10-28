import { and, count, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { follow, user } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { decodeCursor, toPage } from '../../lib/cursor.js';
import { backfillFeed, removeFromFeed } from '../feed/fanout.js';
import type { UserSummary } from '../users/schemas.js';

const notFound = () => new AppError(404, 'USER_NOT_FOUND', 'User not found');

async function assertUserExists(db: Db, id: string): Promise<void> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.id, id));
  if (!row) throw notFound();
}

async function followerCount(db: Db, userId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(follow).where(eq(follow.followeeId, userId));
  return row?.n ?? 0;
}

export async function followUser(db: Db, followerId: string, followeeId: string) {
  if (followerId === followeeId) {
    throw new AppError(400, 'CANNOT_FOLLOW_SELF', 'You cannot follow yourself');
  }
  await assertUserExists(db, followeeId);
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(follow)
      .values({ followerId, followeeId })
      .onConflictDoNothing()
      .returning({ followerId: follow.followerId });
    if (inserted.length > 0) await backfillFeed(tx, followerId, followeeId);
  });
  return { following: true as const, followerCount: await followerCount(db, followeeId) };
}

export async function unfollowUser(db: Db, followerId: string, followeeId: string) {
  await assertUserExists(db, followeeId);
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(follow)
      .where(and(eq(follow.followerId, followerId), eq(follow.followeeId, followeeId)))
      .returning({ followerId: follow.followerId });
    if (deleted.length > 0) await removeFromFeed(tx, followerId, followeeId);
  });
  return { following: false as const, followerCount: await followerCount(db, followeeId) };
}

/** Followers (users following `userId`) or following (users `userId` follows), newest first. */
export async function listFollows(
  db: Db,
  viewerId: string,
  userId: string,
  kind: 'followers' | 'following',
  q: { cursor?: string; limit: number },
) {
  await assertUserExists(db, userId);
  const [ownerCol, listedCol] =
    kind === 'followers' ? [follow.followeeId, follow.followerId] : [follow.followerId, follow.followeeId];

  const conds = [eq(ownerCol, userId)];
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    conds.push(sql`(${follow.createdAt}, ${listedCol}) < (${c.t}::timestamptz, ${c.id})`);
  }
  const viewerFollow = db
    .select({ followeeId: follow.followeeId })
    .from(follow)
    .where(eq(follow.followerId, viewerId))
    .as('viewer_follow');

  const rows = await db
    .select({
      id: user.id,
      username: user.username,
      displayName: user.name,
      avatarUrl: user.image,
      followedAt: follow.createdAt,
      viewerFollowee: viewerFollow.followeeId,
    })
    .from(follow)
    .innerJoin(user, eq(user.id, listedCol))
    .leftJoin(viewerFollow, eq(viewerFollow.followeeId, user.id))
    .where(and(...conds))
    .orderBy(sql`${follow.createdAt} desc`, sql`${listedCol} desc`)
    .limit(q.limit + 1);

  const page = toPage(rows, q.limit, (r) => ({ t: r.followedAt.toISOString(), id: r.id }));
  return {
    items: page.items.map(
      (r): UserSummary & { isFollowing: boolean } => ({
        id: r.id,
        username: r.username!,
        displayName: r.displayName,
        avatarUrl: r.avatarUrl,
        isFollowing: r.viewerFollowee !== null,
      }),
    ),
    nextCursor: page.nextCursor,
  };
}
