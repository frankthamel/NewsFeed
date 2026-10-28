import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { follow as followTable } from '../src/db/schema.js';

export const app = createApp();

/** Truncate every table in the public schema (tolerates zero tables). */
export async function resetDb(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_\\_%' AND tablename <> 'drizzle_migrations'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function req(
  method: string,
  path: string,
  opts: { token?: string; json?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.json !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, {
    method,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body, headers: res.headers };
}

let counter = 0;

export async function signUp(
  overrides: Partial<{ email: string; password: string; name: string; username: string }> = {},
): Promise<{ token: string; user: { id: string; username: string; name: string } }> {
  const n = `${Date.now().toString(36)}${counter++}`;
  const body = {
    email: `user${n}@test.dev`,
    password: 'password123',
    name: `User ${n}`,
    username: `user${n}`,
    ...overrides,
  };
  const r = await req('POST', '/api/auth/sign-up/email', { json: body });
  if (r.status !== 200) throw new Error(`signUp failed: ${r.status} ${JSON.stringify(r.body)}`);
  const token = r.headers.get('set-auth-token');
  if (!token) throw new Error('signUp: no set-auth-token header');
  return { token, user: { id: r.body.user.id, username: r.body.user.username, name: r.body.user.name } };
}

/** Make the token's owner follow `followeeId` through the API. */
export async function follow(followerToken: string, followeeId: string): Promise<void> {
  const r = await req('PUT', `/api/v1/users/${followeeId}/follow`, { token: followerToken });
  if (r.status !== 200) throw new Error(`follow failed: ${r.status} ${JSON.stringify(r.body)}`);
}

/** PUT each buffer to its presigned URL (in order of `start.uploads`). */
export async function uploadFiles(
  start: { uploads: { url: string; headers: Record<string, string> }[] },
  buffers: (Buffer | null)[],
): Promise<void> {
  for (let i = 0; i < start.uploads.length; i++) {
    const buf = buffers[i];
    if (!buf) continue;
    const u = start.uploads[i]!;
    const res = await fetch(u.url, { method: 'PUT', headers: u.headers, body: new Uint8Array(buf) });
    if (res.status !== 200) throw new Error(`upload ${i} failed: ${res.status}`);
  }
}

/** Test-only: write an object straight to storage, bypassing presigned constraints. */
export async function putObjectRaw(key: string, contentType: string, body: Buffer): Promise<void> {
  const { PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  const { env } = await import('../src/env.js');
  const s3 = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  });
  await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType, Body: body }));
}
