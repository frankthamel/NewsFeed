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
