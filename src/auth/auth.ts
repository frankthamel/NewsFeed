import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, openAPI, username } from 'better-auth/plugins';
import { db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { env } from '../env.js';

/** Same rule as PATCH /me (checked after Better Auth lowercases the username). */
export const USERNAME_RE = /^[a-z0-9_]{3,30}$/;

/**
 * The only Better Auth endpoints the app exposes (path below /api/auth → method).
 * Everything else (update-user, change-email, delete-user, ...) would bypass profile validation and the
 * avatar flow, so it is answered with 404 and left out of the OpenAPI document.
 */
export const AUTH_ROUTES: Record<string, 'GET' | 'POST'> = {
  '/sign-up/email': 'POST',
  '/sign-in/email': 'POST',
  '/sign-out': 'POST',
  '/get-session': 'GET',
};

export function isAllowedAuthRoute(method: string, path: string): boolean {
  return Object.hasOwn(AUTH_ROUTES, path) && AUTH_ROUTES[path] === method.toUpperCase();
}

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  // Mobile clients send no Origin header; CSRF origin checks apply to cookie flows only.
  trustedOrigins: [env.BETTER_AUTH_URL],
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: { enabled: true, autoSignIn: true },
  user: {
    additionalFields: {
      // Set only through PATCH /me (max 280); never accepted at sign-up.
      bio: { type: 'string', required: false, input: false },
    },
  },
  hooks: {
    // Sign-up gets the same profile rules as PATCH /me. The username plugin validates the format,
    // but only makes the field optional, so presence is enforced here.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-up/email') return;
      const body = (ctx.body ?? {}) as { username?: unknown; name?: unknown; image?: unknown };
      if (typeof body.username !== 'string' || body.username.trim() === '') {
        throw new APIError('BAD_REQUEST', { message: 'username is required' });
      }
      if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 60) {
        throw new APIError('BAD_REQUEST', { message: 'name must be 1-60 characters' });
      }
      if (body.image !== undefined) {
        throw new APIError('BAD_REQUEST', { message: 'image cannot be set at sign-up; use the avatar upload flow' });
      }
    }),
  },
  plugins: [
    bearer(),
    username({
      minUsernameLength: 3,
      maxUsernameLength: 30,
      usernameValidator: (u) => USERNAME_RE.test(u),
      validationOrder: { username: 'post-normalization' },
    }),
    openAPI(),
  ],
});
