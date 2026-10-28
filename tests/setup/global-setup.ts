import { existsSync, readdirSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const TEST_URL = 'postgres://newsfeed:newsfeed@localhost:5432/newsfeed_test';

export default async function setup() {
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
