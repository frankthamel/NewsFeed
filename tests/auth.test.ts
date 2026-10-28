import { beforeEach, describe, expect, it } from 'vitest';
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
});
