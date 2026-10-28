import { z } from '@hono/zod-openapi';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True if `s` is a uuid (any case). */
export const isUuid = (s: string): boolean => UUID_RE.test(s);

/**
 * Lenient uuid-ish input, lowercased at the boundary. Clients (iOS `UUID().uuidString`) send uppercase,
 * while the server stores and compares lowercase ids. Not validated here: routes where a malformed id
 * means "not found" check `isUuid` themselves, so a bad id becomes a 404 / rejected result, not a 400.
 */
export const UuidLike = z.string().toLowerCase().openapi({ format: 'uuid' });

/** Strict uuid input (400 if malformed), lowercased at the boundary. */
export const Uuid = z.string().uuid().toLowerCase();
