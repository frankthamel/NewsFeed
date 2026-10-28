import '../src/load-env.js';
import { pathToFileURL } from 'node:url';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from '../src/db/client.js';
import { env } from '../src/env.js';
import { deleteObjects, internalClient } from '../src/lib/storage.js';

async function emptyBucket(): Promise<number> {
  let removed = 0;
  let token: string | undefined;
  do {
    const page = await internalClient.send(
      new ListObjectsV2Command({ Bucket: env.S3_BUCKET, ContinuationToken: token }),
    );
    const keys = (page.Contents ?? []).map((o) => o.Key!).filter(Boolean);
    await deleteObjects(keys);
    removed += keys.length;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return removed;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Throws unless wiping the target database is acceptable. Pure: touches nothing. */
export function assertResetAllowed(databaseUrl: string, nodeEnv?: string, allowFlag?: string): void {
  if (nodeEnv === 'production') {
    throw new Error('Refusing to reset the database: NODE_ENV is "production".');
  }
  const host = new URL(databaseUrl).hostname;
  if (!LOCAL_HOSTS.has(host) && allowFlag !== '1') {
    throw new Error(
      `Refusing to reset the database: host "${host}" is not local. Set ALLOW_DB_RESET=1 to override.`,
    );
  }
}

/** Drop everything (schemas `public` and `drizzle`), re-run migrations and empty the media bucket. */
export async function resetDatabase(): Promise<void> {
  assertResetAllowed(env.DATABASE_URL, process.env.NODE_ENV, process.env.ALLOW_DB_RESET);
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('CREATE SCHEMA public');
  await migrate(db, { migrationsFolder: 'drizzle' });
  const removed = await emptyBucket();
  console.log(`Database reset and migrated; removed ${removed} object(s) from "${env.S3_BUCKET}".`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await resetDatabase();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
