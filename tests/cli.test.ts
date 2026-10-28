import { describe, expect, it } from 'vitest';
import { buildSeedArgs } from '../scripts/cli.js';

describe('buildSeedArgs', () => {
  it('builds args without reset', () => {
    expect(buildSeedArgs(12, 6, false)).toEqual(['db:seed', '--', '--users=12', '--posts=6']);
  });
  it('appends --reset', () => {
    expect(buildSeedArgs(4, 2, true)).toEqual(['db:seed', '--', '--users=4', '--posts=2', '--reset']);
  });
});
