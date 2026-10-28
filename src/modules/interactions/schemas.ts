import { z } from '@hono/zod-openapi';
import type { ErrorCode } from '../../lib/errors.js';
import { Uuid, UuidLike } from '../../lib/uuid.js';
import { CommentSchema, type Comment } from '../posts/schemas.js';

const opBase = {
  opId: Uuid,
  clientTimestamp: z.string().datetime({ offset: true }),
};
const CommentText = z.string().min(1).max(2000);

export const OperationSchema = z
  .discriminatedUnion('type', [
    z.object({ ...opBase, type: z.enum(['like', 'unlike']), postId: Uuid }),
    z.object({
      ...opBase,
      type: z.literal('comment.create'),
      postId: Uuid,
      commentId: Uuid,
      text: CommentText,
    }),
    z.object({
      ...opBase,
      type: z.literal('comment.edit'),
      commentId: Uuid,
      text: CommentText,
      baseVersion: z.number().int().min(1),
    }),
    z.object({ ...opBase, type: z.literal('comment.delete'), commentId: Uuid }),
  ])
  .openapi('Operation');
export type Operation = z.infer<typeof OperationSchema>;

export const OP_STATUSES = ['applied', 'duplicate', 'superseded', 'conflict', 'rejected'] as const;
export type OpStatus = (typeof OP_STATUSES)[number];

export const PostStateSchema = z
  .object({
    id: z.string(),
    likeCount: z.number().int(),
    commentCount: z.number().int(),
    likedByMe: z.boolean(),
    version: z.number().int(),
    deleted: z.boolean(),
  })
  .openapi('PostState');
export type PostState = z.infer<typeof PostStateSchema>;

export const OpResultSchema = z
  .object({
    opId: z.string(),
    status: z.enum(OP_STATUSES),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    canonical: z.object({
      post: PostStateSchema.optional(),
      comment: CommentSchema.nullable().optional(),
    }),
  })
  .openapi('OpResult');

export type OpResult = {
  opId: string;
  status: OpStatus;
  error?: { code: ErrorCode; message: string };
  canonical: { post?: PostState; comment?: Comment | null };
};

// ---- Route bodies (single-interaction endpoints) ----

const clientOp = {
  clientOpId: Uuid,
  clientTimestamp: z.string().datetime({ offset: true }),
};

export const ClientOpBodySchema = z.object(clientOp).openapi('ClientOpBody');

export const CreateCommentBodySchema = z
  .object({ id: Uuid, text: CommentText, ...clientOp })
  .openapi('CreateCommentBody', {
    example: {
      id: '5b0f6d52-4f0e-4a43-9c5e-0b3f1a7d9e11',
      text: 'Great photo!',
      clientOpId: '0c9d2c3e-7a58-4c1b-8d57-6d7a1f0b2a90',
      clientTimestamp: '2026-10-28T09:30:00.000Z',
    },
  });

export const EditCommentBodySchema = z
  .object({ text: CommentText, baseVersion: z.number().int().min(1), ...clientOp })
  .openapi('EditCommentBody');

/** Lenient id param: a non-uuid id becomes a rejected *_NOT_FOUND result, never a cast error. */
export const IdParamSchema = z.object({ id: UuidLike });

/** What an op handler decides inside the transaction; canonical state is attached afterwards. */
export type OpOutcome = { status: OpStatus; error?: { code: ErrorCode; message: string } };
