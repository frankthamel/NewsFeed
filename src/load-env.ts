import { existsSync } from 'node:fs';

// Imported first by the server entry point and CLI scripts so `src/env.ts` sees the .env values (real env vars still win).
if (existsSync('.env')) process.loadEnvFile('.env');
