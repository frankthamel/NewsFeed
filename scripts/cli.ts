import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import * as p from '@clack/prompts';

const URLS = {
  api: 'http://localhost:3000',
  docs: 'http://localhost:3000/docs',
  console: 'http://localhost:9001',
};
const DEMO_LOGIN = { email: 'demo1@newsfeed.dev', password: 'password123' };

export function buildSeedArgs(users: number, posts: number, reset: boolean): string[] {
  return ['db:seed', '--', `--users=${users}`, `--posts=${posts}`, ...(reset ? ['--reset'] : [])];
}

export function checkPort(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function servicesReachable(): Promise<boolean> {
  const [pg, s3] = await Promise.all([checkPort(5432), checkPort(9000)]);
  return pg && s3;
}

/** Runs `npm run <args>` with inherited stdio. Resolves to the exit code (non-zero on failure). */
function npmRun(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', ...args], { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Long-running dev server: Ctrl+C stops the child but keeps the CLI alive. */
function runDevServer(): Promise<number> {
  return new Promise((resolve) => {
    // Own process group so the whole tsx watch tree can be stopped.
    const child = spawn('npm', ['run', 'dev'], { stdio: 'inherit', detached: true });
    let interrupted = false;
    const onSigint = () => {
      interrupted = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };
    process.on('SIGINT', onSigint);
    const finish = (code: number) => {
      process.removeListener('SIGINT', onSigint);
      resolve(code);
    };
    child.on('error', () => finish(1));
    child.on('close', (code, signal) => finish(interrupted || signal ? 0 : (code ?? 1)));
  });
}

async function report(label: string, code: number): Promise<boolean> {
  if (code === 0) p.log.success(`${label}: done`);
  else p.log.error(`${label}: failed (exit ${code})`);
  return code === 0;
}

/** Ensures Postgres and S3 are up; offers to start them. Returns false if the action should abort. */
async function ensureServices(): Promise<boolean> {
  if (await servicesReachable()) return true;
  const start = await p.confirm({ message: 'Postgres (5432) or S3 storage (9000) is not reachable. Start services now?' });
  if (p.isCancel(start) || !start) return false;
  if (!(await report('Start services', await npmRun(['services:up'])))) return false;
  return servicesReachable();
}

function showUrls(): void {
  p.note(
    [
      `API:                       ${URLS.api}`,
      `Swagger docs:              ${URLS.docs}`,
      `S3 storage (RustFS) console: ${URLS.console}`,
      '',
      `Demo login: ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`,
    ].join('\n'),
    'URLs',
  );
}

async function seedFlow(): Promise<void> {
  const num = (v: string | undefined) => (v && /^\d+$/.test(v) && Number(v) > 0 ? undefined : 'Enter a positive integer');
  const users = await p.text({ message: 'Number of users', initialValue: '12', validate: num });
  if (p.isCancel(users)) return;
  const posts = await p.text({ message: 'Posts per user', initialValue: '6', validate: num });
  if (p.isCancel(posts)) return;
  const reset = await p.confirm({ message: 'Reset demo data first?', initialValue: false });
  if (p.isCancel(reset)) return;
  if (!(await ensureServices())) return;
  await report('Seed', await npmRun(buildSeedArgs(Number(users), Number(posts), reset)));
}

async function fullSetup(): Promise<void> {
  const steps: { label: string; run: () => Promise<number> }[] = [
    { label: 'Start services', run: () => npmRun(['services:up']) },
    { label: 'Run migrations', run: () => npmRun(['db:migrate']) },
    { label: 'Seed demo data', run: () => npmRun(buildSeedArgs(12, 6, true)) },
    { label: 'Dev server', run: runDevServer },
  ];
  for (const step of steps) {
    p.log.step(step.label);
    if (!(await report(step.label, await step.run()))) {
      p.log.error(`Full setup stopped at "${step.label}".`);
      return;
    }
    if (step.label === 'Start services' && !(await servicesReachable())) {
      p.log.error('Services did not become reachable. Full setup stopped.');
      return;
    }
  }
}

type Action =
  | 'up' | 'down' | 'migrate' | 'seed' | 'reset' | 'dev' | 'full' | 'test' | 'urls' | 'exit';

async function handle(action: Action): Promise<void> {
  switch (action) {
    case 'up':
      await report('Start services', await npmRun(['services:up']));
      return;
    case 'down':
      await report('Stop services', await npmRun(['services:down']));
      return;
    case 'migrate':
      if (await ensureServices()) await report('Migrations', await npmRun(['db:migrate']));
      return;
    case 'seed':
      await seedFlow();
      return;
    case 'reset': {
      const ok = await p.confirm({ message: 'Reset the database? This wipes all data.', initialValue: false });
      if (p.isCancel(ok) || !ok) return;
      if (await ensureServices()) await report('Reset database', await npmRun(['db:reset']));
      return;
    }
    case 'dev':
      p.log.info('Starting dev server. Press Ctrl+C to stop and return to the menu.');
      await report('Dev server', await runDevServer());
      return;
    case 'full':
      await fullSetup();
      return;
    case 'test':
      if (await ensureServices()) await report('Tests', await npmRun(['test']));
      return;
    case 'urls':
      showUrls();
      return;
    default:
      return;
  }
}

async function main(): Promise<void> {
  p.intro('NewsFeed dev tool');
  for (;;) {
    const action = await p.select<Action>({
      message: 'What would you like to do?',
      options: [
        { value: 'up', label: 'Start services (Postgres + S3 storage (RustFS))' },
        { value: 'down', label: 'Stop services' },
        { value: 'migrate', label: 'Run migrations' },
        { value: 'seed', label: 'Seed demo data' },
        { value: 'reset', label: 'Reset database' },
        { value: 'dev', label: 'Start dev server' },
        { value: 'full', label: 'Full setup' },
        { value: 'test', label: 'Run tests' },
        { value: 'urls', label: 'Show URLs' },
        { value: 'exit', label: 'Exit' },
      ],
    });
    if (p.isCancel(action) || action === 'exit') break;
    await handle(action);
  }
  p.outro('Bye');
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
