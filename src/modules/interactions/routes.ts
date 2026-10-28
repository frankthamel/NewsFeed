import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { requireAuth } from '../../auth/middleware.js';
import type { AppEnv } from '../../app.js';
import { db } from '../../db/client.js';
import { errorResponses } from '../../lib/openapi.js';
import { applyOperation, opResultHttpStatus } from './operations.js';
import {
  ClientOpBodySchema,
  CreateCommentBodySchema,
  EditCommentBodySchema,
  IdParamSchema,
  OpResultSchema,
  type Operation,
} from './schemas.js';

const security = [{ bearerAuth: [] }];
const json = <T extends object>(schema: T) => ({ 'application/json': { schema } });
const body = <T extends object>(schema: T) => ({ body: { required: true, content: json(schema) } });

const opResponses = {
  200: { description: 'applied / duplicate / superseded', content: json(OpResultSchema) },
  403: { description: 'rejected: FORBIDDEN', content: json(OpResultSchema) },
  404: { description: 'rejected: POST_NOT_FOUND / COMMENT_NOT_FOUND', content: json(OpResultSchema) },
  409: { description: 'conflict, or rejected: ID_CONFLICT', content: json(OpResultSchema) },
  410: { description: 'rejected: POST_DELETED / COMMENT_DELETED', content: json(OpResultSchema) },
  ...errorResponses(400, 401),
};

const likeRoute = createRoute({
  method: 'put',
  path: '/posts/{id}/like',
  tags: ['Interactions'],
  summary: 'Like a post (idempotent on clientOpId, last-write-wins on clientTimestamp)',
  security,
  middleware: [requireAuth] as const,
  request: { params: IdParamSchema, ...body(ClientOpBodySchema) },
  responses: opResponses,
});

const unlikeRoute = createRoute({
  method: 'delete',
  path: '/posts/{id}/like',
  tags: ['Interactions'],
  summary: 'Unlike a post (idempotent on clientOpId, last-write-wins on clientTimestamp)',
  security,
  middleware: [requireAuth] as const,
  request: { params: IdParamSchema, ...body(ClientOpBodySchema) },
  responses: opResponses,
});

const createCommentRoute = createRoute({
  method: 'post',
  path: '/posts/{id}/comments',
  tags: ['Interactions'],
  summary: 'Comment on a post with a client-generated comment id',
  security,
  middleware: [requireAuth] as const,
  request: { params: IdParamSchema, ...body(CreateCommentBodySchema) },
  responses: { 201: { description: 'applied', content: json(OpResultSchema) }, ...opResponses },
});

const editCommentRoute = createRoute({
  method: 'patch',
  path: '/comments/{id}',
  tags: ['Interactions'],
  summary: 'Edit your comment (optimistic concurrency on baseVersion)',
  security,
  middleware: [requireAuth] as const,
  request: { params: IdParamSchema, ...body(EditCommentBodySchema) },
  responses: opResponses,
});

const deleteCommentRoute = createRoute({
  method: 'delete',
  path: '/comments/{id}',
  tags: ['Interactions'],
  summary: 'Delete a comment (comment author or post author; idempotent)',
  security,
  middleware: [requireAuth] as const,
  request: { params: IdParamSchema, ...body(ClientOpBodySchema) },
  responses: opResponses,
});

export function interactionsRoutes() {
  const r = new OpenAPIHono<AppEnv>();

  // Every handler builds an Operation and defers to applyOperation, the same path /sync uses.
  const run = async (userId: string, op: Operation) => {
    const result = await applyOperation(db, userId, op);
    return { result, status: opResultHttpStatus(result, op.type) as 200 };
  };

  r.openapi(likeRoute, async (c) => {
    const { clientOpId, clientTimestamp } = c.req.valid('json');
    const { id } = c.req.valid('param');
    const { result, status } = await run(c.var.user.id, { opId: clientOpId, type: 'like', postId: id, clientTimestamp });
    return c.json(result, status);
  });

  r.openapi(unlikeRoute, async (c) => {
    const { clientOpId, clientTimestamp } = c.req.valid('json');
    const { id } = c.req.valid('param');
    const { result, status } = await run(c.var.user.id, { opId: clientOpId, type: 'unlike', postId: id, clientTimestamp });
    return c.json(result, status);
  });

  r.openapi(createCommentRoute, async (c) => {
    const b = c.req.valid('json');
    const { result, status } = await run(c.var.user.id, {
      opId: b.clientOpId,
      type: 'comment.create',
      postId: c.req.valid('param').id,
      commentId: b.id,
      text: b.text,
      clientTimestamp: b.clientTimestamp,
    });
    return c.json(result, status);
  });

  r.openapi(editCommentRoute, async (c) => {
    const b = c.req.valid('json');
    const { result, status } = await run(c.var.user.id, {
      opId: b.clientOpId,
      type: 'comment.edit',
      commentId: c.req.valid('param').id,
      text: b.text,
      baseVersion: b.baseVersion,
      clientTimestamp: b.clientTimestamp,
    });
    return c.json(result, status);
  });

  r.openapi(deleteCommentRoute, async (c) => {
    const b = c.req.valid('json');
    const { result, status } = await run(c.var.user.id, {
      opId: b.clientOpId,
      type: 'comment.delete',
      commentId: c.req.valid('param').id,
      clientTimestamp: b.clientTimestamp,
    });
    return c.json(result, status);
  });

  return r;
}
