import { randomUUID } from 'node:crypto';
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { requireAuth } from '../../auth/middleware.js';
import type { AppEnv } from '../../app.js';
import { db } from '../../db/client.js';
import { pageSchema } from '../../lib/cursor.js';
import { errorResponses } from '../../lib/openapi.js';
import { extFor, presignPut } from '../../lib/storage.js';
import {
  AvatarCompleteSchema,
  AvatarUploadRequestSchema,
  AvatarUploadResponseSchema,
  ProfileSchema,
  SearchQuerySchema,
  UpdateProfileSchema,
  UserIdParamSchema,
  UserProfileSchema,
  UserSummarySchema,
} from './schemas.js';
import { completeAvatar, getUserProfile, searchUsers, updateProfile } from './service.js';

const security = [{ bearerAuth: [] }];
const json = <T extends object>(schema: T) => ({ 'application/json': { schema } });

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['Users'],
  summary: 'Get the authenticated user profile',
  security,
  middleware: [requireAuth] as const,
  responses: {
    200: { description: 'Profile', content: json(ProfileSchema) },
    ...errorResponses(401),
  },
});

const patchMeRoute = createRoute({
  method: 'patch',
  path: '/me',
  tags: ['Users'],
  summary: 'Update the authenticated user profile',
  security,
  middleware: [requireAuth] as const,
  request: { body: { required: true, content: json(UpdateProfileSchema) } },
  responses: {
    200: { description: 'Updated profile', content: json(ProfileSchema) },
    ...errorResponses(400, 401, 409),
  },
});

const avatarUploadRoute = createRoute({
  method: 'post',
  path: '/me/avatar/upload-url',
  tags: ['Users'],
  summary: 'Get a presigned URL for uploading an avatar',
  security,
  middleware: [requireAuth] as const,
  request: { body: { required: true, content: json(AvatarUploadRequestSchema) } },
  responses: {
    200: { description: 'Presigned upload', content: json(AvatarUploadResponseSchema) },
    ...errorResponses(400, 401),
  },
});

const avatarCompleteRoute = createRoute({
  method: 'post',
  path: '/me/avatar/complete',
  tags: ['Users'],
  summary: 'Finish an avatar upload and set it as the profile image',
  security,
  middleware: [requireAuth] as const,
  request: { body: { required: true, content: json(AvatarCompleteSchema) } },
  responses: {
    200: { description: 'Updated profile', content: json(ProfileSchema) },
    ...errorResponses(400, 401, 403, 409),
  },
});

const searchRoute = createRoute({
  method: 'get',
  path: '/users',
  tags: ['Users'],
  summary: 'Search users by username or display name prefix',
  security,
  middleware: [requireAuth] as const,
  request: { query: SearchQuerySchema },
  responses: {
    200: { description: 'Page of users', content: json(pageSchema(UserSummarySchema)) },
    ...errorResponses(400, 401),
  },
});

const getUserRoute = createRoute({
  method: 'get',
  path: '/users/{id}',
  tags: ['Users'],
  summary: 'Get a user profile with counts',
  security,
  middleware: [requireAuth] as const,
  request: { params: UserIdParamSchema },
  responses: {
    200: { description: 'User profile', content: json(UserProfileSchema) },
    ...errorResponses(401, 404),
  },
});

export function usersRoutes() {
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(meRoute, async (c) => {
    const p = await getUserProfile(db, c.var.user.id, c.var.user.id);
    const { followerCount: _a, followingCount: _b, postCount: _c, isFollowing: _d, ...profile } = p;
    return c.json(profile, 200);
  });

  r.openapi(patchMeRoute, async (c) => {
    return c.json(await updateProfile(db, c.var.user.id, c.req.valid('json')), 200);
  });

  r.openapi(avatarUploadRoute, async (c) => {
    const { contentType, sizeBytes } = c.req.valid('json');
    const avatarKey = `avatars/${c.var.user.id}/${randomUUID()}.${extFor(contentType)}`;
    const signed = await presignPut(avatarKey, contentType, sizeBytes);
    return c.json({ avatarKey, ...signed }, 200);
  });

  r.openapi(avatarCompleteRoute, async (c) => {
    const { avatarKey } = c.req.valid('json');
    return c.json(await completeAvatar(db, c.var.user.id, avatarKey), 200);
  });

  r.openapi(searchRoute, async (c) => {
    return c.json(await searchUsers(db, c.var.user.id, c.req.valid('query')), 200);
  });

  r.openapi(getUserRoute, async (c) => {
    return c.json(await getUserProfile(db, c.var.user.id, c.req.valid('param').id), 200);
  });

  return r;
}
