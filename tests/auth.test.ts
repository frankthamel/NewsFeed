import { inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { user } from '../src/db/schema.js';
import { req, resetDb, signUp } from './helpers.js';

beforeEach(resetDb);

describe('auth', () => {
  it('sign up returns a bearer token usable on /me', async () => {
    const r = await req('POST', '/api/auth/sign-up/email', {
      json: { email: 'a@x.dev', password: 'password123', name: 'Ann', username: 'ann' },
    });
    expect(r.status).toBe(200);
    const token = r.headers.get('set-auth-token');
    expect(token).toBeTruthy();
    const me = await req('GET', '/api/v1/me', { token: token! });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ username: 'ann', displayName: 'Ann', bio: null, avatarUrl: null });
  });

  it('rejects sign-up without a username', async () => {
    const r = await req('POST', '/api/auth/sign-up/email', {
      json: { email: 'nouser@x.dev', password: 'password123', name: 'No User' },
    });
    expect(r.status).toBe(400);
  });

  it('sign in returns a fresh token', async () => {
    await signUp({ email: 'b@x.dev', password: 'password123' });
    const r = await req('POST', '/api/auth/sign-in/email', { json: { email: 'b@x.dev', password: 'password123' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-auth-token')).toBeTruthy();
  });

  it('rejects missing or bad tokens with error shape', async () => {
    expect((await req('GET', '/api/v1/me')).body.error.code).toBe('UNAUTHORIZED');
    expect((await req('GET', '/api/v1/me', { token: 'garbage' })).status).toBe(401);
  });

  it('sign out invalidates the token', async () => {
    const { token } = await signUp();
    await req('POST', '/api/auth/sign-out', { token });
    expect((await req('GET', '/api/v1/me', { token })).status).toBe(401);
  });

  it('openapi includes Better Auth paths', async () => {
    const spec = await req('GET', '/openapi.json');
    expect(Object.keys(spec.body.paths)).toEqual(
      expect.arrayContaining(['/api/auth/sign-up/email', '/api/auth/sign-in/email', '/api/v1/me']),
    );
  });

  it('openapi auth paths are limited to the documented set', async () => {
    const spec = await req('GET', '/openapi.json');
    const authPaths = Object.keys(spec.body.paths).filter((p) => p.startsWith('/api/auth')).sort();
    expect(authPaths).toEqual(
      ['/api/auth/get-session', '/api/auth/sign-in/email', '/api/auth/sign-out', '/api/auth/sign-up/email'].sort(),
    );
  });
});

const signUpRaw = (json: Record<string, unknown>) =>
  req('POST', '/api/auth/sign-up/email', {
    json: { email: `${Math.random().toString(36).slice(2)}@x.dev`, password: 'password123', name: 'Ann', ...json },
  });

describe('auth surface', () => {
  it('blocks undocumented Better Auth routes such as /update-user', async () => {
    const { token } = await signUp({ name: 'Ann' });
    const before = (await req('GET', '/api/v1/me', { token })).body;
    for (const [method, path, json] of [
      ['POST', '/api/auth/update-user', { image: 'https://evil.example/x.png', bio: 'x'.repeat(10_000), name: '' }],
      ['POST', '/api/auth/change-email', { newEmail: 'evil@x.dev' }],
      ['POST', '/api/auth/delete-user', {}],
      ['POST', '/api/auth/sign-in/username', { username: 'ann', password: 'password123' }],
      ['GET', '/api/auth/list-sessions', undefined],
    ] as const) {
      const r = await req(method, path, { token, json });
      expect(r.status, `${method} ${path}`).toBe(404);
    }
    expect((await req('GET', '/api/v1/me', { token })).body).toEqual(before);
  });

  it('keeps get-session working', async () => {
    const { token, user: u } = await signUp();
    const r = await req('GET', '/api/auth/get-session', { token });
    expect(r.status).toBe(200);
    expect(r.body.user.id).toBe(u.id);
  });

  it('rejects usernames that PATCH /me would reject', async () => {
    expect((await signUpRaw({ username: 'a.b' })).status).toBe(400);
    expect((await signUpRaw({ username: 'ab' })).status).toBe(400);
    expect((await signUpRaw({ username: 'a'.repeat(31) })).status).toBe(400);
    // Uppercase is lowercased first, then validated.
    const ok = await signUpRaw({ username: 'Mixed_Case1' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.username).toBe('mixed_case1');
  });

  it('rejects an image at sign-up and never persists a sign-up bio', async () => {
    expect((await signUpRaw({ username: 'imgu', image: 'https://evil.example/x.png' })).status).toBe(400);
    expect((await signUpRaw({ username: 'biou', bio: 'x'.repeat(10_000) })).status).toBe(400);
    const rows = await db.select().from(user).where(inArray(user.username, ['imgu', 'biou']));
    expect(rows).toHaveLength(0);
  });

  it('bounds name to 1..60 at sign-up', async () => {
    expect((await signUpRaw({ username: 'noname', name: '' })).status).toBe(400);
    expect((await signUpRaw({ username: 'longname', name: 'n'.repeat(61) })).status).toBe(400);
    expect((await signUpRaw({ username: 'okname', name: 'n'.repeat(60) })).status).toBe(200);
  });
});
