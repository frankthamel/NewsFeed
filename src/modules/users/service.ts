import { and, count, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { follow, post, user } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { decodeCursor, toPage } from '../../lib/cursor.js';
import { avatarUrlFor, headObject } from '../../lib/storage.js';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, type UserProfile, type UserSummary } from './schemas.js';

type UserRow = typeof user.$inferSelect;

export function toProfile(row: UserRow) {
  return {
    id: row.id,
    username: row.username!,
    displayName: row.name,
    bio: row.bio,
    avatarUrl: avatarUrlFor(row.image),
    createdAt: row.createdAt.toISOString(),
  };
}

function toSummary(row: UserRow): UserSummary {
  return { id: row.id, username: row.username!, displayName: row.name, avatarUrl: avatarUrlFor(row.image) };
}

export async function getUserSummaries(db: Db, ids: string[]): Promise<Map<string, UserSummary>> {
  const out = new Map<string, UserSummary>();
  if (ids.length === 0) return out;
  const rows = await db.select().from(user).where(inArray(user.id, [...new Set(ids)]));
  for (const r of rows) out.set(r.id, toSummary(r));
  return out;
}

export async function assertUserExists(db: Db, id: string): Promise<void> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.id, id));
  if (!row) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
}

export async function getUserProfile(db: Db, viewerId: string, userId: string): Promise<UserProfile> {
  const [row] = await db.select().from(user).where(eq(user.id, userId));
  if (!row) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

  const [[followers], [following], [posts], rel] = await Promise.all([
    db.select({ n: count() }).from(follow).where(eq(follow.followeeId, userId)),
    db.select({ n: count() }).from(follow).where(eq(follow.followerId, userId)),
    db
      .select({ n: count() })
      .from(post)
      .where(and(eq(post.authorId, userId), eq(post.status, 'published'), isNull(post.deletedAt))),
    viewerId === userId
      ? Promise.resolve([])
      : db
          .select({ x: sql`1` })
          .from(follow)
          .where(and(eq(follow.followerId, viewerId), eq(follow.followeeId, userId))),
  ]);

  return {
    ...toProfile(row),
    followerCount: followers?.n ?? 0,
    followingCount: following?.n ?? 0,
    postCount: posts?.n ?? 0,
    isFollowing: rel.length > 0,
  };
}

export async function updateProfile(
  db: Db,
  userId: string,
  patch: { displayName?: string; bio?: string | null; username?: string },
) {
  const set: Partial<typeof user.$inferInsert> = {};
  if (patch.displayName !== undefined) set.name = patch.displayName;
  if (patch.bio !== undefined) set.bio = patch.bio;
  if (patch.username !== undefined) {
    set.username = patch.username;
    set.displayUsername = patch.username;
  }
  if (Object.keys(set).length === 0) return getRow(db, userId);
  try {
    const [row] = await db.update(user).set(set).where(eq(user.id, userId)).returning();
    if (!row) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    return toProfile(row);
  } catch (e) {
    if ((e as { code?: string }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505') {
      throw new AppError(409, 'ID_CONFLICT', 'Username already taken');
    }
    throw e;
  }
}

async function getRow(db: Db, userId: string) {
  const [row] = await db.select().from(user).where(eq(user.id, userId));
  if (!row) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return toProfile(row);
}

/** The shape upload-url hands out: avatars/<owner id>/<uuid>.<ext>. Anything else never reaches storage. */
const AVATAR_KEY_RE = /^avatars\/([A-Za-z0-9_-]+)\/[0-9a-f-]{36}\.(jpg|png|webp|heic)$/;

export async function completeAvatar(db: Db, userId: string, avatarKey: string) {
  const m = AVATAR_KEY_RE.exec(avatarKey);
  if (!m) throw new AppError(400, 'VALIDATION_ERROR', 'Malformed avatar key');
  if (m[1] !== userId) throw new AppError(403, 'FORBIDDEN', 'Avatar key does not belong to you');
  const head = await headObject(avatarKey);
  if (!head) throw new AppError(409, 'UPLOAD_INCOMPLETE', 'Avatar has not been uploaded');
  if (!(IMAGE_TYPES as readonly string[]).includes(head.contentType) || head.sizeBytes > MAX_IMAGE_BYTES) {
    throw new AppError(422, 'MEDIA_MISMATCH', 'Avatar must be a jpeg, png, webp or heic image of at most 10 MB', {
      contentType: head.contentType,
      sizeBytes: head.sizeBytes,
    });
  }
  // Store the key, not a URL: avatarUrlFor resolves it against the current public endpoint on read.
  const [row] = await db.update(user).set({ image: avatarKey }).where(eq(user.id, userId)).returning();
  if (!row) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return toProfile(row);
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export async function searchUsers(
  db: Db,
  viewerId: string,
  q: { search: string; cursor?: string; limit: number },
) {
  const pattern = `${escapeLike(q.search)}%`;
  const conds = [
    ne(user.id, viewerId),
    or(sql`${user.username} ILIKE ${pattern}`, sql`${user.name} ILIKE ${pattern}`),
  ];
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    conds.push(sql`(${user.createdAt}, ${user.id}) < (${c.t}::timestamp, ${c.id})`);
  }
  const rows = await db
    .select()
    .from(user)
    .where(and(...conds))
    .orderBy(sql`${user.createdAt} desc`, sql`${user.id} desc`)
    .limit(q.limit + 1);
  const page = toPage(rows, q.limit, (r) => ({ t: r.createdAt.toISOString(), id: r.id }));
  return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
}
