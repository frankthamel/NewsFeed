import { describe, expect, it } from 'vitest';
import { assertResetAllowed } from '../scripts/reset-db.js';

const local = 'postgres://u:p@localhost:5432/db';

describe('assertResetAllowed', () => {
  it('allows localhost', () => {
    expect(() => assertResetAllowed(local)).not.toThrow();
  });
  it('allows 127.0.0.1', () => {
    expect(() => assertResetAllowed('postgres://u:p@127.0.0.1:5432/db')).not.toThrow();
  });
  it('refuses a remote host', () => {
    expect(() => assertResetAllowed('postgres://u:p@db.example.com:5432/db')).toThrow(/db\.example\.com.*ALLOW_DB_RESET/);
  });
  it('allows a remote host with ALLOW_DB_RESET=1', () => {
    expect(() => assertResetAllowed('postgres://u:p@db.example.com:5432/db', undefined, '1')).not.toThrow();
  });
  it('refuses production even on localhost', () => {
    expect(() => assertResetAllowed(local, 'production')).toThrow(/production/);
  });
});
