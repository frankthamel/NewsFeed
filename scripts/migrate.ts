import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

if (existsSync('.env')) process.loadEnvFile('.env');

const url = process.env.DATABASE_URL ?? 'postgres://newsfeed:newsfeed@localhost:5432/newsfeed';
const pool = new pg.Pool({ connectionString: url });
try {
  await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
  console.log('Migrations applied.');
} finally {
  await pool.end();
}
