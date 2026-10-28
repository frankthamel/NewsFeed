import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, toPage } from '../src/lib/cursor.js';

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
