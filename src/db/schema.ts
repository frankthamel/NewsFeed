import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth-schema.js';

export * from './auth-schema.js';

export const postTypeEnum = pgEnum('post_type', ['text', 'image', 'video']);
export const postStatusEnum = pgEnum('post_status', ['pending', 'published']);
export const mediaKindEnum = pgEnum('media_kind', ['image', 'video', 'thumbnail']);
export const uploadStatusEnum = pgEnum('upload_status', ['open', 'completed', 'expired']);


export const follow = pgTable(
  'follow',
  {
    followerId: text('follower_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    followeeId: text('followee_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followeeId] }),
    check('follow_no_self', sql`${t.followerId} <> ${t.followeeId}`),
    index('follow_followee_idx').on(t.followeeId),
  ],
);

export const post = pgTable(
  'post',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    authorId: text('author_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    type: postTypeEnum('type').notNull(),
    text: text('text'),
    status: postStatusEnum('status').notNull(),
    likeCount: integer('like_count').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, precision: 3 }),
    deletedAt: timestamp('deleted_at', { withTimezone: true, precision: 3 }),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [index('post_author_published_idx').on(t.authorId, t.publishedAt.desc(), t.id.desc())],
);

export const media = pgTable(
  'media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    kind: mediaKindEnum('kind').notNull(),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    durationSec: real('duration_sec'),
    position: integer('position').notNull(),
    uploaded: boolean('uploaded').notNull().default(false),
  },
  (t) => [index('media_post_idx').on(t.postId)],
);

export const uploadSession = pgTable(
  'upload_session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    postType: postTypeEnum('post_type').notNull(),
    status: uploadStatusEnum('status').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, precision: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [index('upload_session_status_expires_idx').on(t.status, t.expiresAt)],
);

export const feedItem = pgTable(
  'feed_item',
  {
    ownerId: text('owner_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerId, t.postId] }),
    index('feed_item_owner_created_idx').on(t.ownerId, t.createdAt.desc(), t.postId.desc()),
    index('feed_item_owner_author_idx').on(t.ownerId, t.authorId),
  ],
);

export const like = pgTable(
  'like',
  {
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    liked: boolean('liked').notNull(),
    clientUpdatedAt: timestamp('client_updated_at', { withTimezone: true, precision: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.userId] }),
    index('like_post_liked_updated_idx').on(t.postId, t.liked, t.updatedAt.desc()),
  ],
);

export const comment = pgTable(
  'comment',
  {
    id: uuid('id').primaryKey(),
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    version: integer('version').notNull().default(1),
    clientCreatedAt: timestamp('client_created_at', { withTimezone: true, precision: 3 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, precision: 3 }),
  },
  (t) => [index('comment_post_created_idx').on(t.postId, t.createdAt, t.id)],
);

export const clientOperation = pgTable(
  'client_operation',
  {
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    opId: uuid('op_id').notNull(),
    type: text('type').notNull(),
    outcome: text('outcome').notNull(),
    postId: uuid('post_id'),
    commentId: uuid('comment_id'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.opId] })],
);
