import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().default('http://localhost:3000'),
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
  S3_BUCKET: z.string().default('newsfeed-media'),
});

const parsed = schema.parse(process.env);

export const env = {
  ...parsed,
  S3_PUBLIC_ENDPOINT: parsed.S3_PUBLIC_ENDPOINT ?? parsed.S3_ENDPOINT,
};
