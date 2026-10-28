import { z } from '@hono/zod-openapi';

export const ProfileSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
    bio: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('Profile');

export const UserSummarySchema = z
  .object({
    id: z.string(),
    username: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
  })
  .openapi('UserSummary');
export type UserSummary = z.infer<typeof UserSummarySchema>;

export const UserProfileSchema = ProfileSchema.extend({
  followerCount: z.number().int(),
  followingCount: z.number().int(),
  postCount: z.number().int(),
  isFollowing: z.boolean(),
}).openapi('UserProfile');
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const UserIdParamSchema = z.object({ id: z.string().min(1) });

export const UpdateProfileSchema = z
  .object({
    displayName: z.string().min(1).max(60).optional(),
    bio: z.string().max(280).nullable().optional(),
    username: z
      .string()
      .min(3)
      .max(30)
      .regex(/^[a-z0-9_]+$/, 'lowercase letters, digits and underscore only')
      .optional(),
  })
  .openapi('UpdateProfile');

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
export const MAX_IMAGE_BYTES = 10_485_760;

export const AvatarUploadRequestSchema = z
  .object({
    contentType: z.enum(IMAGE_TYPES),
    sizeBytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
  })
  .openapi('AvatarUploadRequest');

export const AvatarUploadResponseSchema = z
  .object({
    avatarKey: z.string(),
    url: z.string(),
    method: z.literal('PUT'),
    headers: z.record(z.string(), z.string()),
  })
  .openapi('AvatarUploadResponse');

export const AvatarCompleteSchema = z.object({ avatarKey: z.string().min(1) }).openapi('AvatarComplete');

export const SearchQuerySchema = z.object({
  search: z.string().trim().min(1).max(60),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
