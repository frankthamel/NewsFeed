import { z } from '@hono/zod-openapi';
import { Uuid, UuidLike } from '../../lib/uuid.js';
import { UserSummarySchema } from '../users/schemas.js';

export const MediaSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['image', 'video', 'thumbnail']),
    url: z.string(),
    contentType: z.string(),
    sizeBytes: z.number().int(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    durationSec: z.number().nullable(),
    position: z.number().int(),
  })
  .openapi('Media');
export type Media = z.infer<typeof MediaSchema>;

export const CommentSchema = z
  .object({
    id: z.string(),
    postId: z.string(),
    author: UserSummarySchema,
    text: z.string(),
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    edited: z.boolean(),
  })
  .openapi('Comment');
export type Comment = z.infer<typeof CommentSchema>;

export const FeedItemSchema = z
  .object({
    id: z.string(),
    type: z.enum(['text', 'image', 'video']),
    text: z.string().nullable(),
    author: UserSummarySchema,
    media: z.array(MediaSchema),
    likeCount: z.number().int(),
    commentCount: z.number().int(),
    likedByMe: z.boolean(),
    latestComments: z.array(CommentSchema),
    version: z.number().int(),
    createdAt: z.string(),
  })
  .openapi('FeedItem');
export type FeedItem = z.infer<typeof FeedItemSchema>;

export const CreatePostSchema = z
  .object({
    type: z.literal('text'),
    text: z.string().min(1).max(5000),
    clientOpId: Uuid.optional(),
  })
  .openapi('CreatePost');

export const PostIdParamSchema = z.object({ id: Uuid });

/** Lenient id param for read routes: a non-uuid id is a 404, not a validation error. */
export const PostLookupParamSchema = z.object({ id: UuidLike });

export const PostDetailSchema = FeedItemSchema.extend({
  author: UserSummarySchema.extend({
    followerCount: z.number().int(),
    isFollowing: z.boolean(),
  }),
}).openapi('PostDetail');
export type PostDetail = z.infer<typeof PostDetailSchema>;

export const LikerSchema = UserSummarySchema.extend({ likedAt: z.string() }).openapi('Liker');

export const RefreshBodySchema = z
  .object({
    // Lenient ids: a non-uuid id is reported in `deleted`, not rejected.
    posts: z.array(z.object({ id: UuidLike, version: z.number().int() })).min(1).max(200),
  })
  .openapi('RefreshBody');

export const RefreshResponseSchema = z
  .object({ updated: z.array(FeedItemSchema), deleted: z.array(z.string()) })
  .openapi('RefreshResponse');
