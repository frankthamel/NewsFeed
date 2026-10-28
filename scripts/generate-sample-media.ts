import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ffmpegPath = createRequire(import.meta.url)('ffmpeg-static') as string | null;

if (!ffmpegPath) throw new Error('ffmpeg-static has no binary for this platform');
const out = join(import.meta.dirname, 'sample-media');
mkdirSync(out, { recursive: true });

function ffmpeg(args: string[]): void {
  execFileSync(ffmpegPath!, ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
}

// 8 square JPEGs, each from a different lavfi source.
const images = [
  'testsrc=size=1080x1080',
  'testsrc2=size=1080x1080',
  'smptehdbars=size=1080x1080',
  'rgbtestsrc=size=1080x1080',
  'gradients=size=1080x1080:seed=3',
  'gradients=size=1080x1080:seed=11:speed=0.02',
  'mandelbrot=size=1080x1080',
  'pal75bars=size=1080x1080',
];
images.forEach((src, i) => {
  ffmpeg(['-f', 'lavfi', '-i', src, '-frames:v', '1', '-q:v', '8', join(out, `image-${i + 1}.jpg`)]);
});

// 2 five-second 720p videos, each with a poster frame.
const videos = ['testsrc2=size=1280x720:rate=24', 'testsrc=size=1280x720:rate=24'];
videos.forEach((src, i) => {
  const n = i + 1;
  const file = join(out, `video-${n}.mp4`);
  ffmpeg([
    '-f', 'lavfi', '-i', src, '-t', '5',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    file,
  ]);
  ffmpeg(['-i', file, '-frames:v', '1', '-q:v', '8', join(out, `video-${n}-poster.jpg`)]);
});
console.log(`Wrote sample media to ${out}`);
