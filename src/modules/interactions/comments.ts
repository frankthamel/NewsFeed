import { eq, sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { comment, post } from '../../db/schema.js';
import { clampClientTime } from '../../lib/time.js';
import type { OpOutcome, Operation } from './schemas.js';

type CreateOp = Extract<Operation, { type: 'comment.create' }>;
type EditOp = Extract<Operation, { type: 'comment.edit' }>;
type DeleteOp = Extract<Operation, { type: 'comment.delete' }>;
type CommentRow = typeof comment.$inferSelect;

async function bumpPost(tx: Tx, postId: string, commentDelta: number): Promise<void> {
  await tx
    .update(post)
    .set({
      ...(commentDelta !== 0 ? { commentCount: sql`${post.commentCount} + ${commentDelta}` } : {}),
      version: sql`${post.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(post.id, postId));
}

/** Caller holds the post row lock. Idempotent on the client-generated comment id. */
export async function createComment(tx: Tx, userId: string, op: CreateOp): Promise<OpOutcome> {
  // DO NOTHING (not a plain insert) so a concurrent insert of the same id on another post
  // waits for that transaction and then lands here instead of raising a unique violation.
  const [inserted] = await tx
    .insert(comment)
    .values({
      id: op.commentId,
      postId: op.postId,
      authorId: userId,
      text: op.text,
      clientCreatedAt: clampClientTime(op.clientTimestamp),
    })
    .onConflictDoNothing({ target: comment.id })
    .returning({ id: comment.id });

  if (!inserted) {
    const [existing] = await tx.select().from(comment).where(eq(comment.id, op.commentId));
    if (existing && existing.authorId === userId && existing.postId === op.postId) {
      return { status: 'duplicate' };
    }
    return {
      status: 'rejected',
      error: { code: 'ID_CONFLICT', message: 'Comment id is already used by another comment' },
    };
  }

  await bumpPost(tx, op.postId, 1);
  return { status: 'applied' };
}

/** Caller holds the post row lock, then the comment row lock (`c` is that locked row). */
export async function editComment(tx: Tx, userId: string, c: CommentRow, op: EditOp): Promise<OpOutcome> {
  if (c.authorId !== userId) {
    return { status: 'rejected', error: { code: 'FORBIDDEN', message: 'Only the author can edit this comment' } };
  }
  if (c.deletedAt) {
    return { status: 'rejected', error: { code: 'COMMENT_DELETED', message: 'Comment has been deleted' } };
  }
  if (op.baseVersion !== c.version) return { status: 'conflict' };

  await tx
    .update(comment)
    .set({ text: op.text, version: sql`${comment.version} + 1`, updatedAt: new Date() })
    .where(eq(comment.id, c.id));
  await bumpPost(tx, c.postId, 0);
  return { status: 'applied' };
}

/** Caller holds the post row lock, then the comment row lock. Comment author or post author may delete. */
export async function deleteComment(
  tx: Tx,
  userId: string,
  c: CommentRow,
  postAuthorId: string,
  _op: DeleteOp,
): Promise<OpOutcome> {
  if (c.authorId !== userId && postAuthorId !== userId) {
    return { status: 'rejected', error: { code: 'FORBIDDEN', message: 'Not allowed to delete this comment' } };
  }
  if (c.deletedAt) return { status: 'applied' }; // idempotent no-op

  const now = new Date();
  await tx.update(comment).set({ deletedAt: now, updatedAt: now }).where(eq(comment.id, c.id));
  await bumpPost(tx, c.postId, -1);
  return { status: 'applied' };
}
