import { z } from '@hono/zod-openapi';
import { AppError } from './errors.js';

/** Keyset position: the sort timestamp plus the row id as tie-breaker. */
export type Cursor = { t: string; id: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ t: c.t, id: c.id })).toString('base64url');
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function decodeCursor(s: string): Cursor {
  const invalid = () => new AppError(400, 'INVALID_CURSOR', 'Invalid cursor');
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw invalid();

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();

  const { t, id } = parsed as Record<string, unknown>;
  if (typeof t !== 'string' || !ISO_UTC.test(t) || Number.isNaN(Date.parse(t))) throw invalid();
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw invalid();

  return { t, id };
}

export const PageQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

/**
 * Callers fetch `limit + 1` rows. If more than `limit` came back, the extra
 * row is dropped and the cursor points at the last kept row.
 */
export function toPage<R>(
  rows: R[],
  limit: number,
  cursorOf: (r: R) => Cursor,
): { items: R[]; nextCursor: string | null } {
  if (rows.length > limit) {
    const items = rows.slice(0, limit);
    return { items, nextCursor: encodeCursor(cursorOf(items[items.length - 1]!)) };
  }
  return { items: rows, nextCursor: null };
}
