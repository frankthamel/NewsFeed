import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, PageQuerySchema, toPage } from '../src/lib/cursor.js';

describe('cursor', () => {
  it('round-trips', () => {
    const c = { t: '2026-10-28T10:00:00.000Z', id: 'abc' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it.each([
    '%%%',
    'bm90IGpzb24',
    Buffer.from('{"t":"x","id":"1"}').toString('base64url'),
    Buffer.from('{"id":"1"}').toString('base64url'),
  ])('rejects %s with INVALID_CURSOR', (s) => {
    expect(() => decodeCursor(s)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CURSOR', status: 400 }),
    );
  });

  it('toPage sets nextCursor only when there is an extra row', () => {
    const rows = [1, 2, 3].map((i) => ({ id: String(i), at: new Date(2026, 0, i) }));
    const p = toPage(rows, 2, (r) => ({ t: r.at.toISOString(), id: r.id }));
    expect(p.items).toHaveLength(2);
    expect(decodeCursor(p.nextCursor!)).toEqual({ t: rows[1].at.toISOString(), id: '2' });
    expect(toPage(rows, 3, (r) => ({ t: r.at.toISOString(), id: r.id })).nextCursor).toBeNull();
  });
});

const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

describe('decodeCursor strict validation', () => {
  it.each([
    ['t is "1"', enc({ t: '1', id: 'a' })],
    ['t is "2026"', enc({ t: '2026', id: 'a' })],
    ['t is "Jan 1"', enc({ t: 'Jan 1', id: 'a' })],
    ['t is a number', enc({ t: 1, id: '1' })],
    ['payload is JSON null', enc(null)],
    ['payload is an array', enc([])],
    ['payload is a string', enc('str')],
    ['id is empty', enc({ t: '2026-10-28T10:00:00.000Z', id: '' })],
    ['id has a space', enc({ t: '2026-10-28T10:00:00.000Z', id: 'a b' })],
    ['id is 65 characters', enc({ t: '2026-10-28T10:00:00.000Z', id: 'a'.repeat(65) })],
  ])('rejects when %s with INVALID_CURSOR', (_label, s) => {
    expect(() => decodeCursor(s)).toThrowError(
      expect.objectContaining({ code: 'INVALID_CURSOR', status: 400 }),
    );
  });

  it('accepts a 64-character id and fractional-second UTC timestamps', () => {
    const c = { t: '2026-10-28T10:00:00.123456Z', id: 'a'.repeat(64) };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });
});

describe('PageQuerySchema', () => {
  it('defaults limit to 20 and accepts 50', () => {
    expect(PageQuerySchema.parse({}).limit).toBe(20);
    expect(PageQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it.each(['51', '0', 'abc'])('rejects limit %s', (limit) => {
    expect(PageQuerySchema.safeParse({ limit }).success).toBe(false);
  });
});
