import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'INVALID_CURSOR'
  | 'POST_NOT_FOUND'
  | 'POST_DELETED'
  | 'COMMENT_NOT_FOUND'
  | 'COMMENT_DELETED'
  | 'CANNOT_FOLLOW_SELF'
  | 'USER_NOT_FOUND'
  | 'UPLOAD_NOT_FOUND'
  | 'UPLOAD_EXPIRED'
  | 'UPLOAD_INCOMPLETE'
  | 'MEDIA_MISMATCH'
  | 'ID_CONFLICT'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorBody(code: ErrorCode, message: string, details?: unknown) {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

export function onError(err: Error, c: Context) {
  if (err instanceof AppError) {
    return c.json(errorBody(err.code, err.message, err.details), err.status as ContentfulStatusCode);
  }
  console.error(err);
  return c.json(errorBody('INTERNAL', 'Internal server error'), 500);
}

export function onNotFound(c: Context) {
  return c.json(errorBody('NOT_FOUND', 'Route not found'), 404);
}
