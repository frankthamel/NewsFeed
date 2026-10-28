import './load-env.js';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { like } from 'drizzle-orm';
import { auth } from '../src/auth/auth.js';
import { db, pool } from '../src/db/client.js';
import { user } from '../src/db/schema.js';
import { presignPut } from '../src/lib/storage.js';
import { followUser } from '../src/modules/follows/service.js';
import { applyOperation } from '../src/modules/interactions/operations.js';
import { createTextPost } from '../src/modules/posts/service.js';
import { completeUpload, startUpload } from '../src/modules/uploads/service.js';
import { completeAvatar } from '../src/modules/users/service.js';
import { resetDatabase } from './reset-db.js';

const MEDIA_DIR = join(import.meta.dirname, 'sample-media');
const PASSWORD = 'password123';
const DAY_MS = 86_400_000;

export type SeedOptions = { users: number; postsPerUser: number; reset: boolean };
export type SeedSummary = {
  users: number;
  posts: number;
  textPosts: number;
  imagePosts: number;
  videoPosts: number;
  follows: number;
  likes: number;
  comments: number;
  credentials: { email: string; password: string; username: string }[];
};

// Fixed 20-post cycle: 10 text (50%), 7 image (35%), 3 video (15%).
const KIND_CYCLE = [
  'text', 'image', 'text', 'image', 'text', 'video', 'text', 'image', 'text', 'image',
  'text', 'image', 'text', 'video', 'text', 'image', 'text', 'image', 'text', 'video',
] as const;

const NAMES = ['Ava Chen', 'Liam Patel', 'Noah Silva', 'Mia Okafor', 'Ethan Brooks', 'Zoe Martin', 'Lucas Novak', 'Isla Rossi', 'Owen Kim', 'Ruby Haddad', 'Leo Fischer', 'Nora Tanaka'];
const TEXTS = [
  'Morning coffee and a fresh start.',
  'Just shipped a small feature, feels great.',
  'Anyone else watching the sunset right now?',
  'Weekend hike was worth every step.',
  'Trying out a new recipe tonight.',
  'Reading a great book, no spoilers please.',
  'Learning something new every day.',
  'Rainy day, perfect for staying in.',
  'Big thanks to everyone who helped out this week.',
  'Quick sketch from my lunch break.',
];
const CAPTIONS = ['Test pattern of the day', 'Colors everywhere', 'Calibration time', 'Pixel perfect', 'A little abstract today'];
const COMMENTS = ['Love this!', 'Great shot.', 'Totally agree.', 'Haha, nice one.', 'Congrats!', 'Where was this?', 'Looks amazing.'];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readMedia(name: string): Buffer {
  return readFileSync(join(MEDIA_DIR, name));
}

async function putTo(upload: { url: string; headers: Record<string, string> }, body: Buffer): Promise<void> {
  const res = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: new Uint8Array(body) });
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`);
}

export async function seed(opts: SeedOptions): Promise<SeedSummary> {
  if (opts.reset) await resetDatabase();
  const existing = await db.select({ id: user.id }).from(user).where(like(user.email, 'demo%@newsfeed.dev')).limit(1);
  if (existing.length > 0) throw new Error('demo users exist; use --reset to wipe and reseed');

  const rand = mulberry32(20261028);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const shuffle = <T>(arr: T[]): T[] => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  };

  // Users + avatars
  const users: { id: string; email: string; username: string }[] = [];
  for (let i = 1; i <= opts.users; i++) {
    const email = `demo${i}@newsfeed.dev`;
    const username = `demo${i}`;
    const name = NAMES[(i - 1) % NAMES.length]!;
    const res = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name, username } });
    const id = res.user.id;
    const file = readMedia(`image-${((i - 1) % 8) + 1}.jpg`);
    const avatarKey = `avatars/${id}/${randomUUID()}.jpg`;
    await putTo(await presignPut(avatarKey, 'image/jpeg', file.length), file);
    await completeAvatar(db, id, avatarKey);
    users.push({ id, email, username });
  }

  // Follow graph: demo1 follows everyone, everyone else follows 3-6 others.
  let follows = 0;
  for (const [idx, u] of users.entries()) {
    const others = users.filter((o) => o.id !== u.id);
    const targets = idx === 0 ? others : shuffle([...others]).slice(0, Math.min(others.length, 3 + Math.floor(rand() * 4)));
    for (const t of targets) {
      await followUser(db, u.id, t.id);
      follows++;
    }
  }

  // Posts, published at random moments over the past 14 days.
  const nowMs = Date.now();
  const posts: { id: string; authorId: string }[] = [];
  const counts = { text: 0, image: 0, video: 0 };
  let seq = 0;
  for (const u of users) {
    for (let p = 0; p < opts.postsPerUser; p++) {
      const kind = KIND_CYCLE[seq++ % KIND_CYCLE.length]!;
      const now = new Date(nowMs - Math.floor(rand() * 14 * DAY_MS));
      let postId: string;
      if (kind === 'text') {
        postId = (await createTextPost(db, u.id, { text: pick(TEXTS) }, { now })).post.id;
      } else if (kind === 'image') {
        const n = 1 + Math.floor(rand() * 4);
        const names = Array.from({ length: n }, () => `image-${1 + Math.floor(rand() * 8)}.jpg`);
        const buffers = names.map(readMedia);
        const start = await startUpload(db, u.id, {
          type: 'image',
          text: rand() < 0.7 ? pick(CAPTIONS) : undefined,
          files: buffers.map((b) => ({ kind: 'image' as const, contentType: 'image/jpeg', sizeBytes: b.length, width: 1080, height: 1080 })),
        });
        for (const [i, up] of start.uploads.entries()) await putTo(up, buffers[i]!);
        postId = (await completeUpload(db, u.id, start.uploadId, { now })).id;
      } else {
        const v = 1 + Math.floor(rand() * 2);
        const video = readMedia(`video-${v}.mp4`);
        const poster = readMedia(`video-${v}-poster.jpg`);
        const start = await startUpload(db, u.id, {
          type: 'video',
          text: rand() < 0.7 ? pick(CAPTIONS) : undefined,
          files: [
            { kind: 'video', contentType: 'video/mp4', sizeBytes: video.length, width: 1280, height: 720, durationSec: 5 },
            { kind: 'thumbnail', contentType: 'image/jpeg', sizeBytes: poster.length, width: 1280, height: 720 },
          ],
        });
        await putTo(start.uploads[0]!, video);
        await putTo(start.uploads[1]!, poster);
        postId = (await completeUpload(db, u.id, start.uploadId, { now })).id;
      }
      counts[kind]++;
      posts.push({ id: postId, authorId: u.id });
    }
  }

  // Likes and comments through the same operation path the API uses.
  let likes = 0;
  let comments = 0;
  for (const p of posts) {
    for (const u of users) {
      if (rand() < 0.4) {
        const r = await applyOperation(db, u.id, { type: 'like', opId: randomUUID(), postId: p.id, clientTimestamp: new Date().toISOString() });
        if (r.status === 'applied') likes++;
      }
      if (rand() < 0.2) {
        const r = await applyOperation(db, u.id, {
          type: 'comment.create',
          opId: randomUUID(),
          postId: p.id,
          commentId: randomUUID(),
          text: pick(COMMENTS),
          clientTimestamp: new Date().toISOString(),
        });
        if (r.status === 'applied') comments++;
      }
    }
  }

  return {
    users: users.length,
    posts: posts.length,
    textPosts: counts.text,
    imagePosts: counts.image,
    videoPosts: counts.video,
    follows,
    likes,
    comments,
    credentials: users.map((u) => ({ email: u.email, password: PASSWORD, username: u.username })),
  };
}

function parseArgs(argv: string[]): SeedOptions {
  const num = (name: string, fallback: number) => {
    const a = argv.find((x) => x.startsWith(`--${name}=`));
    const n = a ? Number(a.split('=')[1]) : fallback;
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
    return n;
  };
  return { users: num('users', 12), postsPerUser: num('posts', 6), reset: argv.includes('--reset') };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const { credentials, ...summary } = await seed(parseArgs(process.argv.slice(2)));
    console.log('Seeded:', summary);
    console.table(credentials);
    console.log('Swagger UI: http://localhost:3000/docs');
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
