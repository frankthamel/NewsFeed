import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env.js';

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle(pool);

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
