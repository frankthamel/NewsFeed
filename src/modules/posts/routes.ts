import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { requireAuth } from '../../auth/middleware.js';
import type { AppEnv } from '../../app.js';
import { db } from '../../db/client.js';
import { PageQuerySchema, pageSchema } from '../../lib/cursor.js';
import { errorResponses } from '../../lib/openapi.js';
import { UserIdParamSchema } from '../users/schemas.js';
import {
  CommentSchema,
  CreatePostSchema,
  FeedItemSchema,
  LikerSchema,
  PostDetailSchema,
  PostIdParamSchema,
  PostLookupParamSchema,
  RefreshBodySchema,
  RefreshResponseSchema,
} from './schemas.js';
import { createTextPost, deletePost, getPostDetail, listComments, listLikers, listUserPosts, refreshPosts } from './service.js';

const security = [{ bearerAuth: [] }];
const json = <T extends object>(schema: T) => ({ 'application/json': { schema } });

const createRoute_ = createRoute({
  method: 'post',
  path: '/posts',
  tags: ['Posts'],
  summary: 'Create a text post (idempotent with clientOpId)',
  description: "Publishes a text post immediately and fans it out to the author's and followers' feeds. Retrying with the same clientOpId returns the original post with 200 instead of creating a duplicate.",
  security,
  middleware: [requireAuth] as const,
  request: { body: { required: true, content: json(CreatePostSchema) } },
  responses: {
    201: { description: 'Created', content: json(FeedItemSchema) },
    200: { description: 'Replay of an earlier request with the same clientOpId', content: json(FeedItemSchema) },
    ...errorResponses(400, 401),
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/posts/{id}',
  tags: ['Posts'],
  summary: 'Delete your own post',
  description: "Soft-deletes the post (author only) and removes it from every feed. Returns 204 with no body.",
  security,
  middleware: [requireAuth] as const,
  request: { params: PostIdParamSchema },
  responses: {
    204: { description: 'Deleted' },
    ...errorResponses(400, 401, 403, 404),
  },
});

const userPostsRoute = createRoute({
  method: 'get',
  path: '/users/{id}/posts',
  tags: ['Posts'],
  summary: "List a user's published posts, newest first",
  description: "Cursor paginated, newest first (default limit 20, max 50). Pending (unpublished) and deleted posts are never listed.",
  security,
  middleware: [requireAuth] as const,
  request: { params: UserIdParamSchema, query: PageQuerySchema },
  responses: {
    200: { description: 'Page of posts', content: json(pageSchema(FeedItemSchema)) },
    ...errorResponses(400, 401),
  },
});

const detailRoute = createRoute({
  method: 'get',
  path: '/posts/{id}',
  tags: ['Posts'],
  summary: 'Get a post with author follower info',
  description: "Returns one published post with current counts, the caller's like state and the author's follower info. Deleted or pending posts return 404.",
  security,
  middleware: [requireAuth] as const,
  request: { params: PostLookupParamSchema },
  responses: {
    200: { description: 'Post', content: json(PostDetailSchema) },
    ...errorResponses(401, 404),
  },
});

const commentsRoute = createRoute({
  method: 'get',
  path: '/posts/{id}/comments',
  tags: ['Posts'],
  summary: 'List comments, oldest first',
  description: "Cursor paginated, oldest first (default limit 20, max 50). Soft-deleted comments are omitted.",
  security,
  middleware: [requireAuth] as const,
  request: { params: PostLookupParamSchema, query: PageQuerySchema },
  responses: {
    200: { description: 'Page of comments', content: json(pageSchema(CommentSchema)) },
    ...errorResponses(400, 401, 404),
  },
});

const likesRoute = createRoute({
  method: 'get',
  path: '/posts/{id}/likes',
  tags: ['Posts'],
  summary: 'List users who like a post, newest first',
  description: "Cursor paginated, newest first (default limit 20, max 50).",
  security,
  middleware: [requireAuth] as const,
  request: { params: PostLookupParamSchema, query: PageQuerySchema },
  responses: {
    200: { description: 'Page of likers', content: json(pageSchema(LikerSchema)) },
    ...errorResponses(400, 401, 404),
  },
});

const refreshRoute = createRoute({
  method: 'post',
  path: '/posts/refresh',
  tags: ['Posts'],
  summary: 'Refresh cached posts: returns changed posts and ids that are gone',
  description: "Send up to 200 cached posts as {id, version}. The response lists posts whose version changed (full current state) and ids that were deleted or are no longer visible, so the app can drop them.",
  security,
  middleware: [requireAuth] as const,
  request: { body: { required: true, content: json(RefreshBodySchema) } },
  responses: {
    200: { description: 'Changed posts and deleted ids', content: json(RefreshResponseSchema) },
    ...errorResponses(400, 401),
  },
});

export function postsRoutes() {
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(createRoute_, async (c) => {
    const { text, clientOpId } = c.req.valid('json');
    const { post, created } = await createTextPost(db, c.var.user.id, { text, clientOpId });
    return created ? c.json(post, 201) : c.json(post, 200);
  });

  r.openapi(deleteRoute, async (c) => {
    await deletePost(db, c.var.user.id, c.req.valid('param').id);
    return c.body(null, 204);
  });

  r.openapi(userPostsRoute, async (c) => {
    return c.json(
      await listUserPosts(db, c.var.user.id, c.req.valid('param').id, c.req.valid('query')),
      200,
    );
  });

  r.openapi(refreshRoute, async (c) =>
    c.json(await refreshPosts(db, c.var.user.id, c.req.valid('json').posts), 200),
  );

  r.openapi(detailRoute, async (c) =>
    c.json(await getPostDetail(db, c.var.user.id, c.req.valid('param').id), 200),
  );

  r.openapi(commentsRoute, async (c) =>
    c.json(await listComments(db, c.req.valid('param').id, c.req.valid('query')), 200),
  );

  r.openapi(likesRoute, async (c) =>
    c.json(await listLikers(db, c.req.valid('param').id, c.req.valid('query')), 200),
  );

  return r;
}
