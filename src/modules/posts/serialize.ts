import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { comment, like, media, post } from '../../db/schema.js';
import { publicUrl } from '../../lib/storage.js';
import { getUserSummaries } from '../users/service.js';
import type { Comment, FeedItem, Media } from './schemas.js';

/** Load published, non-deleted posts in the order of `postIds`. Uses a fixed number of queries. */
export async function serializePosts(db: Db, viewerId: string, postIds: string[]): Promise<FeedItem[]> {
  if (postIds.length === 0) return [];

  const posts = await db
    .select()
    .from(post)
    .where(and(inArray(post.id, postIds), eq(post.status, 'published'), isNull(post.deletedAt)));
  if (posts.length === 0) return [];
  const ids = posts.map((p) => p.id);

  const ranked = db
    .select({
      id: comment.id,
      postId: comment.postId,
      authorId: comment.authorId,
      text: comment.text,
      version: comment.version,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      rn: sql<number>`row_number() over (partition by ${comment.postId} order by ${comment.createdAt} desc, ${comment.id} desc)`.as(
        'rn',
      ),
    })
    .from(comment)
    .where(and(inArray(comment.postId, ids), isNull(comment.deletedAt)))
    .as('ranked');

  const [mediaRows, likeRows, commentRows] = await Promise.all([
    db.select().from(media).where(inArray(media.postId, ids)).orderBy(asc(media.position)),
    db
      .select({ postId: like.postId })
      .from(like)
      .where(and(inArray(like.postId, ids), eq(like.userId, viewerId), eq(like.liked, true))),
    db.select().from(ranked).where(sql`${ranked.rn} <= 2`),
  ]);

  const users = await getUserSummaries(db, [
    ...posts.map((p) => p.authorId),
    ...commentRows.map((c) => c.authorId),
  ]);

  const mediaBy = new Map<string, Media[]>();
  for (const m of mediaRows) {
    const list = mediaBy.get(m.postId) ?? [];
    list.push({
      id: m.id,
      kind: m.kind,
      url: publicUrl(m.objectKey),
      contentType: m.contentType,
      sizeBytes: m.sizeBytes,
      width: m.width,
      height: m.height,
      durationSec: m.durationSec,
      position: m.position,
    });
    mediaBy.set(m.postId, list);
  }
  const liked = new Set(likeRows.map((l) => l.postId));
  const commentsBy = new Map<string, Comment[]>();
  // commentRows are newest-first within a post; reverse to oldest-first.
  for (const c of [...commentRows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))) {
    const author = users.get(c.authorId);
    if (!author) continue;
    const list = commentsBy.get(c.postId) ?? [];
    list.push({
      id: c.id,
      postId: c.postId,
      author,
      text: c.text,
      version: c.version,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      edited: c.version > 1,
    });
    commentsBy.set(c.postId, list);
  }

  const byId = new Map(posts.map((p) => [p.id, p]));
  const out: FeedItem[] = [];
  for (const id of postIds) {
    const p = byId.get(id);
    const author = p && users.get(p.authorId);
    if (!p || !author) continue;
    out.push({
      id: p.id,
      type: p.type,
      text: p.text,
      author,
      media: mediaBy.get(p.id) ?? [],
      likeCount: p.likeCount,
      commentCount: p.commentCount,
      likedByMe: liked.has(p.id),
      latestComments: commentsBy.get(p.id) ?? [],
      version: p.version,
      createdAt: (p.publishedAt ?? p.createdAt).toISOString(),
    });
  }
  return out;
}
