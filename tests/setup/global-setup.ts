import { existsSync, readdirSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

async function ensureBucket() {
  const bucket = process.env.S3_BUCKET ?? 'newsfeed-media';
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY ?? 'rustfsadmin',
      secretAccessKey: process.env.S3_SECRET_KEY ?? 'rustfsadmin',
    },
    forcePathStyle: true,
  });
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (e) {
      // Lost a race with the init container: fine as long as it exists now.
      await s3.send(new HeadBucketCommand({ Bucket: bucket })).catch(() => {
        throw e;
      });
    }
  } finally {
    s3.destroy();
  }
}

const TEST_URL = 'postgres://newsfeed:newsfeed@localhost:5432/newsfeed_test';

export default async function setup() {
  await ensureBucket();
  const folder = 'drizzle';
  // Tolerate a missing/empty migrations folder (no tables yet).
  if (!existsSync(`${folder}/meta/_journal.json`) && !(existsSync(folder) && readdirSync(folder).some((f) => f.endsWith('.sql')))) {
    return;
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? TEST_URL });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}
