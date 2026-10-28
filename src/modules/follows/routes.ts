import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { requireAuth } from '../../auth/middleware.js';
import type { AppEnv } from '../../app.js';
import { db } from '../../db/client.js';
import { PageQuerySchema, pageSchema } from '../../lib/cursor.js';
import { errorResponses } from '../../lib/openapi.js';
import { UserIdParamSchema, UserSummarySchema } from '../users/schemas.js';
import { followUser, listFollows, unfollowUser } from './service.js';

const security = [{ bearerAuth: [] }];
const json = <T extends object>(schema: T) => ({ 'application/json': { schema } });

const FollowStateSchema = z
  .object({ following: z.boolean(), followerCount: z.number().int() })
  .openapi('FollowState');
const FollowListItemSchema = UserSummarySchema.extend({ isFollowing: z.boolean() }).openapi('FollowListItem');

const followRoute = createRoute({
  method: 'put',
  path: '/users/{id}/follow',
  tags: ['Follows'],
  summary: 'Follow a user (idempotent); backfills their latest 50 posts into your feed',
  description: "Idempotent. Creates the follow edge and backfills the followee's latest 50 published posts into the caller's feed. Following yourself returns 400.",
  security,
  middleware: [requireAuth] as const,
  request: { params: UserIdParamSchema },
  responses: {
    200: { description: 'Follow state', content: json(FollowStateSchema) },
    ...errorResponses(400, 401, 404),
  },
});

const unfollowRoute = createRoute({
  method: 'delete',
  path: '/users/{id}/follow',
  tags: ['Follows'],
  summary: 'Unfollow a user (idempotent); removes their posts from your feed',
  description: "Idempotent. Removes the follow edge and deletes the followee's posts from the caller's feed.",
  security,
  middleware: [requireAuth] as const,
  request: { params: UserIdParamSchema },
  responses: {
    200: { description: 'Follow state', content: json(FollowStateSchema) },
    ...errorResponses(401, 404),
  },
});

const listRoute = (kind: 'followers' | 'following') =>
  createRoute({
    method: 'get',
    path: `/users/{id}/${kind}`,
    tags: ['Follows'],
    summary: kind === 'followers' ? 'List a user\'s followers' : 'List users a user follows',
    description: "Cursor paginated (default limit 20, max 50). Each item says whether the caller follows that user.",
    security,
    middleware: [requireAuth] as const,
    request: { params: UserIdParamSchema, query: PageQuerySchema },
    responses: {
      200: { description: 'Page of users', content: json(pageSchema(FollowListItemSchema)) },
      ...errorResponses(400, 401, 404),
    },
  });

export function followsRoutes() {
  const r = new OpenAPIHono<AppEnv>();
  r.openapi(followRoute, async (c) =>
    c.json(await followUser(db, c.var.user.id, c.req.valid('param').id), 200),
  );
  r.openapi(unfollowRoute, async (c) =>
    c.json(await unfollowUser(db, c.var.user.id, c.req.valid('param').id), 200),
  );
  r.openapi(listRoute('followers'), async (c) =>
    c.json(await listFollows(db, c.var.user.id, c.req.valid('param').id, 'followers', c.req.valid('query')), 200),
  );
  r.openapi(listRoute('following'), async (c) =>
    c.json(await listFollows(db, c.var.user.id, c.req.valid('param').id, 'following', c.req.valid('query')), 200),
  );
  return r;
}
