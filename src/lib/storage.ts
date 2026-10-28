import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';

const credentials = { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY };

function makeClient(endpoint: string): S3Client {
  return new S3Client({ endpoint, region: env.S3_REGION, credentials, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED' });
}

/** Used for server-to-storage calls (head, delete). */
export const internalClient = makeClient(env.S3_ENDPOINT);
/** Used only for presigning: the signature covers the host that clients will call. */
const publicClient = makeClient(env.S3_PUBLIC_ENDPOINT);

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

export function extFor(contentType: string): string {
  const ext = EXT[contentType];
  if (!ext) throw new Error(`Unsupported content type: ${contentType}`);
  return ext;
}

export async function presignPut(
  key: string,
  contentType: string,
  sizeBytes: number,
): Promise<{ url: string; method: 'PUT'; headers: Record<string, string> }> {
  const cmd = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: sizeBytes,
  });
  const url = await getSignedUrl(publicClient, cmd, {
    expiresIn: 3600,
    // Keep content-type and content-length in the signature instead of hoisting them away.
    unhoistableHeaders: new Set(['content-type', 'content-length']),
    signableHeaders: new Set(['content-type', 'content-length']),
  });
  return { url, method: 'PUT', headers: { 'Content-Type': contentType } };
}

export async function headObject(key: string): Promise<{ sizeBytes: number; contentType: string } | null> {
  try {
    const out = await internalClient.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return { sizeBytes: out.ContentLength ?? 0, contentType: out.ContentType ?? '' };
  } catch (e) {
    if (e instanceof NotFound || (e as { name?: string }).name === 'NotFound' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw e;
  }
}

export async function deleteObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  for (let i = 0; i < keys.length; i += 1000) {
    await internalClient.send(
      new DeleteObjectsCommand({
        Bucket: env.S3_BUCKET,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}

/** Public URL for an object key, built from the endpoint in effect now (not at upload time). */
export function publicUrl(key: string, base: string = env.S3_PUBLIC_ENDPOINT): string {
  return `${base}/${env.S3_BUCKET}/${key}`;
}

/**
 * The one place a stored `user.image` becomes an API `avatarUrl`. The column holds an object key, resolved
 * on every read so a changed S3_PUBLIC_ENDPOINT applies without reseeding. Legacy full URLs pass through.
 */
export function avatarUrlFor(image: string | null, base: string = env.S3_PUBLIC_ENDPOINT): string | null {
  if (!image) return null;
  if (/^https?:\/\//i.test(image)) return image;
  return publicUrl(image, base);
}
