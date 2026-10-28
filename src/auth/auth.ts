import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, openAPI, username } from 'better-auth/plugins';
import { db } from '../db/client.js';
import * as schema from '../db/schema.js';
import { env } from '../env.js';

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  // Mobile clients send no Origin header; CSRF origin checks apply to cookie flows only.
  trustedOrigins: [env.BETTER_AUTH_URL],
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: { enabled: true, autoSignIn: true },
  user: {
    additionalFields: {
      bio: { type: 'string', required: false, input: true },
    },
  },
  hooks: {
    // Username is required at sign-up (the username plugin only makes it optional).
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-up/email') return;
      const username = (ctx.body as { username?: unknown } | undefined)?.username;
      if (typeof username !== 'string' || username.trim() === '') {
        throw new APIError('BAD_REQUEST', { message: 'username is required' });
      }
    }),
  },
  plugins: [bearer(), username(), openAPI()],
});
