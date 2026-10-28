import { z } from '@hono/zod-openapi';

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'NOT_FOUND' }),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi('Error');

const descriptions: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  409: 'Conflict',
  410: 'Gone',
  422: 'Unprocessable entity',
  500: 'Internal server error',
};

/** OpenAPI response entries for the given error statuses. */
export function errorResponses<S extends number[]>(...statuses: S) {
  const out: Record<number, { description: string; content: { 'application/json': { schema: typeof ErrorSchema } } }> = {};
  for (const s of statuses) {
    out[s] = {
      description: descriptions[s] ?? 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    };
  }
  return out as { [K in S[number]]: (typeof out)[number] };
}
