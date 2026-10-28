import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client.js';
import { clientOperation, comment, like, post } from '../../db/schema.js';
import type { ErrorCode } from '../../lib/errors.js';
import type { Comment } from '../posts/schemas.js';
import { toComment } from '../posts/serialize.js';
import { UUID_RE } from '../posts/service.js';
import { getUserSummaries } from '../users/service.js';
import { createComment, deleteComment, editComment } from './comments.js';
import { applyLike } from './likes.js';
import type { OpOutcome, OpResult, Operation, PostState } from './schemas.js';

type PostRow = typeof post.$inferSelect;

const reject = (code: ErrorCode, message: string): OpOutcome => ({ status: 'rejected', error: { code, message } });

/** Authoritative post state for the app's cache. Missing, pending or non-uuid → `deleted: true` with zero counts. */
export async function getPostState(db: Db, viewerId: string, postId: string): Promise<PostState> {
  const gone: PostState = { id: postId, likeCount: 0, commentCount: 0, likedByMe: false, version: 0, deleted: true };
  if (!UUID_RE.test(postId)) return gone;
  const [p] = await db.select().from(post).where(eq(post.id, postId));
  if (!p || p.status !== 'published') return gone;
  const [l] = await db
    .select({ liked: like.liked })
    .from(like)
    .where(and(eq(like.postId, postId), eq(like.userId, viewerId)));
  return {
    id: p.id,
    likeCount: p.likeCount,
    commentCount: p.commentCount,
    likedByMe: l?.liked ?? false,
    version: p.version,
    deleted: p.deletedAt !== null,
  };
}

async function getCommentState(db: Db, commentId: string): Promise<{ postId: string | null; comment: Comment | null }> {
  if (!UUID_RE.test(commentId)) return { postId: null, comment: null };
  const [c] = await db.select().from(comment).where(eq(comment.id, commentId));
  if (!c) return { postId: null, comment: null };
  if (c.deletedAt) return { postId: c.postId, comment: null };
  const author = (await getUserSummaries(db, [c.authorId])).get(c.authorId);
  return { postId: c.postId, comment: author ? toComment(c, author) : null };
}

/** Canonical state, always re-read now (also for duplicates, so a replay never returns a stale snapshot). */
async function canonicalFor(db: Db, userId: string, op: Operation): Promise<OpResult['canonical']> {
  if (!('commentId' in op)) return { post: await getPostState(db, userId, op.postId) }; // like / unlike
  const cs = await getCommentState(db, op.commentId);
  if (op.type === 'comment.create') {
    // Only echo the comment if it actually lives on the target post (an ID_CONFLICT points elsewhere).
    const sameP = cs.postId === op.postId;
    return { post: await getPostState(db, userId, op.postId), comment: sameP ? cs.comment : null };
  }
  return {
    ...(cs.postId ? { post: await getPostState(db, userId, cs.postId) } : {}),
    comment: cs.comment,
  };
}

/** Lock the post row. Pending/missing → POST_NOT_FOUND; soft-deleted → POST_DELETED. */
async function lockPost(tx: Tx, postId: string): Promise<{ post: PostRow } | { rejected: OpOutcome }> {
  const [p] = await tx.select().from(post).where(eq(post.id, postId)).for('update');
  if (!p || p.status !== 'published') return { rejected: reject('POST_NOT_FOUND', 'Post not found') };
  if (p.deletedAt) return { rejected: reject('POST_DELETED', 'Post has been deleted') };
  return { post: p };
}

/** Runs after the client_operation row is claimed. Lock order: post row, then comment/like row. */
async function dispatch(tx: Tx, userId: string, op: Operation): Promise<OpOutcome> {
  switch (op.type) {
    case 'like':
    case 'unlike': {
      const p = await lockPost(tx, op.postId);
      if ('rejected' in p) return p.rejected;
      return applyLike(tx, userId, op);
    }
    case 'comment.create': {
      const p = await lockPost(tx, op.postId);
      if ('rejected' in p) return p.rejected;
      return createComment(tx, userId, op);
    }
    case 'comment.edit':
    case 'comment.delete': {
      // Resolve the post without locking the comment, so the post lock is always taken first.
      const [ref] = await tx.select({ postId: comment.postId }).from(comment).where(eq(comment.id, op.commentId));
      if (!ref) return reject('COMMENT_NOT_FOUND', 'Comment not found');
      const p = await lockPost(tx, ref.postId);
      if ('rejected' in p) return p.rejected;
      const [c] = await tx.select().from(comment).where(eq(comment.id, op.commentId)).for('update');
      if (!c) return reject('COMMENT_NOT_FOUND', 'Comment not found');
      return op.type === 'comment.edit'
        ? editComment(tx, userId, c, op)
        : deleteComment(tx, userId, c, p.post.authorId, op);
    }
  }
}

/**
 * The single entry point for likes and comments (single routes and /sync).
 * One transaction per op: claim (userId, opId) → lock post → mutate → record outcome.
 * Rejections are normal outcomes: they are recorded and committed, not rolled back.
 */
export async function applyOperation(db: Db, userId: string, op: Operation): Promise<OpResult> {
  const postId = 'postId' in op ? op.postId : undefined;
  const commentId = 'commentId' in op ? op.commentId : undefined;

  // Path params are lenient strings; a non-uuid id can't exist, and must never reach a uuid cast.
  // Not recorded in client_operation (its id columns are uuid); a retry gets the same rejection.
  if (postId !== undefined && !UUID_RE.test(postId)) {
    return {
      opId: op.opId,
      status: 'rejected',
      error: { code: 'POST_NOT_FOUND', message: 'Post not found' },
      canonical: { post: await getPostState(db, userId, postId) },
    };
  }
  if (commentId !== undefined && !UUID_RE.test(commentId)) {
    return {
      opId: op.opId,
      status: 'rejected',
      error: { code: 'COMMENT_NOT_FOUND', message: 'Comment not found' },
      canonical: { comment: null },
    };
  }

  const outcome = await db.transaction(async (tx): Promise<OpOutcome> => {
    // A concurrent identical request blocks here on the PK until the first commits, then sees the row.
    const claimed = await tx
      .insert(clientOperation)
      .values({ userId, opId: op.opId, type: op.type, postId, commentId, outcome: 'pending' })
      .onConflictDoNothing()
      .returning({ opId: clientOperation.opId });
    if (claimed.length === 0) return { status: 'duplicate' };

    const result = await dispatch(tx, userId, op);
    await tx
      .update(clientOperation)
      .set({ outcome: result.error?.code ?? result.status })
      .where(and(eq(clientOperation.userId, userId), eq(clientOperation.opId, op.opId)));
    return result;
  });

  return {
    opId: op.opId,
    status: outcome.status,
    ...(outcome.error ? { error: outcome.error } : {}),
    canonical: await canonicalFor(db, userId, op),
  };
}

const rejectedStatus: Partial<Record<ErrorCode, number>> = {
  POST_DELETED: 410,
  POST_NOT_FOUND: 404,
  COMMENT_NOT_FOUND: 404,
  COMMENT_DELETED: 410,
  FORBIDDEN: 403,
  ID_CONFLICT: 409,
};

/** HTTP status for a single-interaction route. `opType` lets an applied comment.create return 201. */
export function opResultHttpStatus(r: OpResult, opType?: Operation['type']): number {
  switch (r.status) {
    case 'applied':
      return opType === 'comment.create' ? 201 : 200;
    case 'duplicate':
    case 'superseded':
      return 200;
    case 'conflict':
      return 409;
    case 'rejected':
      return (r.error && rejectedStatus[r.error.code]) ?? 400;
  }
}
