import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('load-env location', () => {
  it('lives in src/ and nothing under src/ imports from scripts/', () => {
    expect(existsSync('src/load-env.ts')).toBe(true);
    expect(existsSync('scripts/load-env.ts')).toBe(false);
    for (const f of walk('src').filter((p) => p.endsWith('.ts'))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/from ['"][^'"]*scripts\/|import ['"][^'"]*scripts\//);
    }
  });
});
