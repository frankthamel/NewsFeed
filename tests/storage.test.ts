import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extFor, headObject, presignPut, publicUrl } from '../src/lib/storage.js';

describe('storage', () => {
  it('presigned PUT uploads and headObject reads it back', async () => {
    const key = `test/${randomUUID()}.png`;
    const body = Buffer.alloc(1234, 1);
    const p = await presignPut(key, 'image/png', body.length);
    const put = await fetch(p.url, { method: 'PUT', headers: p.headers, body });
    expect(put.status).toBe(200);
    expect(await headObject(key)).toEqual({ sizeBytes: 1234, contentType: 'image/png' });
    expect(await headObject(`test/missing-${randomUUID()}`)).toBeNull();
    expect((await fetch(publicUrl(key))).status).toBe(200);
  });

  it('presigned PUT rejects a body of a different size', async () => {
    const key = `test/${randomUUID()}.png`;
    const p = await presignPut(key, 'image/png', 100);
    const put = await fetch(p.url, { method: 'PUT', headers: p.headers, body: Buffer.alloc(200) }).catch(() => null);
    expect(put?.status ?? 400).not.toBe(200);
  });

  it('extFor maps content types', () => {
    expect(extFor('image/jpeg')).toBe('jpg');
    expect(extFor('video/quicktime')).toBe('mov');
  });
});
