# NewsFeed API — Design

Date: 2026-10-28
Status: Draft for approval (reviewed)

## 1. Intent

A Facebook-style news feed backend, built with Hono + TypeScript, to power a
mobile client app the author will build later and demo in job interviews.

The backend must be fully functional and well documented (Swagger/OpenAPI) so
the mobile app can be built against it without guesswork. It should also be a
strong interview talking point: realistic patterns (presigned uploads,
fan-out-on-write feeds, cursor pagination, idempotent offline sync) rather than
toy shortcuts.

The mobile app is **offline-first**. It queues interactions (likes, comments)
while offline and replays them later. The **backend is the source of truth**;
the server must resolve conflicts deterministically and tell the client the
canonical state.

## 2. Goals

- Signup, login, logout, session via bearer token (Better Auth).
- User profiles (view, edit own, avatar).
- One-way follow / unfollow; follower & following lists.
- Posts: text, image (multi-image), video (with optional thumbnail image).
- Two-phase media post creation using presigned URLs to local S3-compatible
  storage (MinIO).
- News feed built by fan-out on write, with cursor-based pagination.
- Post detail with paginated comments, paginated likers, author summary.
- Like/unlike, comment, edit/delete own comment, delete own post.
- Offline-sync conflict resolution: idempotent client-generated operation IDs,
  last-write-wins for likes, versioned canonical state in responses, plus a
  batch sync endpoint.
- OpenAPI 3 spec + Swagger UI generated from route definitions.
- Seed script with realistic demo data (users, follows, posts with sample
  images/videos, likes, comments).
- A TypeScript interactive terminal tool (CLI menu) that runs project scripts:
  start/stop services (Docker), start dev server, run migrations, seed, reset,
  run tests.
- Integration tests for key flows.

## 3. Non-goals

- Production deployment, CI/CD, horizontal scaling.
- Media processing (no resizing, transcoding, server-generated thumbnails).
- Friend requests, mutual-friend logic, blocking, privacy settings.
- Notifications, real-time push/WebSockets, messaging.
- Shares/reposts, reactions beyond "like", nested comment replies, hashtags,
  search, ranking algorithms (feed is chronological).
- Email verification, password reset emails, OAuth/social login.
- Admin tooling, moderation.

## 4. Anti-goals (would make this a failure even if it "works")

- Duplicate comments or flipping like state when the offline app retries.
- Offset pagination, or a cursor that skips/duplicates items when new posts
  arrive during scrolling.
- Swagger docs that drift from actual behaviour (docs must be generated from
  the same schemas used for validation).
- Needing a cloud account or internet during the demo.
- Posts visible in feeds before their media has finished uploading.

## 5. Decided stack & environment (user's decisions)

| Concern | Decision |
|---|---|
| Runtime | Local Node.js (current LTS) |
| Framework | Hono, TypeScript |
| Database | PostgreSQL in Docker |
| ORM / migrations | Drizzle ORM + drizzle-kit |
| Object storage | MinIO in Docker (S3-compatible), accessed with AWS S3 SDK |
| Auth | Better Auth, email + password, bearer token plugin |
| Docs | OpenAPI generated from route schemas, Swagger UI served by the app |
| Services | `docker compose` for Postgres + MinIO |

Builder's call (suggested): `@hono/zod-openapi` + `@hono/swagger-ui` for
schema-first routes; Vitest for tests; `@clack/prompts` or similar for the
terminal tool; `pnpm` or `npm` either is fine.

## 6. Domain model (logical)

Builder decides exact columns/types; this is the required shape.

- **user** (Better Auth managed) + profile fields: `username` (unique,
  handle), `displayName`, `bio`, `avatarUrl`, `createdAt`.
- **session / account / verification** — Better Auth tables.
- **follow**: `followerId`, `followeeId`, `createdAt`. Unique pair. Cannot
  follow self.
- **post**: `id`, `authorId`, `type` (`text` | `image` | `video`), `text`
  (optional caption for media posts, required for text posts), `status`
  (`pending` | `published`), `likeCount`, `commentCount`, `version`,
  `createdAt`, `publishedAt`, `deletedAt` (soft delete).
- **media**: `id`, `postId`, `kind` (`image` | `video` | `thumbnail`),
  `objectKey`, `contentType`, `sizeBytes`, `width?`, `height?`,
  `durationSec?`, `position` (order within post), `uploaded` flag.
- **upload_session** ("bucket id" in the original request): `id`, `ownerId`,
  `postType`, `expiresAt`, `status` (`open` | `completed` | `expired`),
  links to its pending post and expected media slots.
- **feed_item**: `ownerId` (feed owner), `postId`, `authorId`, `createdAt`
  (= post `publishedAt`). Primary key `(ownerId, postId)`. Index on
  `(ownerId, createdAt DESC, postId DESC)`.
- **like**: `postId`, `userId`, `liked` (boolean — keep the row on unlike so
  LWW has a timestamp to compare), `clientUpdatedAt`, `updatedAt`. Unique
  `(postId, userId)`.
- **comment**: `id` (UUID, **generated by the client** and sent on create;
  server rejects a reused id belonging to another user/post), `postId`,
  `authorId`, `text`, `version`,
  `clientCreatedAt`, `createdAt`, `updatedAt`, `deletedAt`.
- **client_operation** (idempotency log): `opId` (client UUID, unique per
  user), `userId`, `type`, `outcome` (the original status/error code, not
  the full response), target ids, `createdAt`.

## 7. API surface

All routes under `/api/v1` except Better Auth's own handler. All
authenticated routes require `Authorization: Bearer <token>`. Errors use one
consistent JSON shape: `{ error: { code, message, details? } }`.

### 7.1 Auth (Better Auth)
- `POST /api/auth/sign-up/email` — name, email, password (+ username).
- `POST /api/auth/sign-in/email` — returns bearer token (via Better Auth
  bearer plugin, `set-auth-token` header) — the app stores it.
- `POST /api/auth/sign-out`
- `GET /api/v1/me` — current user + profile.
Better Auth routes must also appear in Swagger (document them manually or
merge Better Auth's OpenAPI plugin output).

### 7.2 Profiles & follows
- `GET /api/v1/users/:id` — profile, follower/following counts, post count,
  `isFollowing`.
- `PATCH /api/v1/me` — update displayName, bio, username.
- Avatar: `POST /api/v1/me/avatar/upload-url` → presigned PUT;
  `POST /api/v1/me/avatar/complete` → verifies and sets `avatarUrl`.
- `GET /api/v1/users/:id/posts` — cursor-paginated.
- `PUT /api/v1/users/:id/follow` / `DELETE /api/v1/users/:id/follow` —
  idempotent.
- `GET /api/v1/users/:id/followers`, `GET /api/v1/users/:id/following` —
  cursor-paginated.
- `GET /api/v1/users?search=` — simple username/displayName prefix search so
  the demo can find people to follow (builder's call to keep or cut).

### 7.3 Post creation
- **Text post:** `POST /api/v1/posts` `{ type: "text", text, clientOpId? }`
  → published immediately, fanned out.
- **Media post, phase 1:** `POST /api/v1/posts/uploads`
  `{ type: "image" | "video", text?, files: [{ kind, contentType, sizeBytes,
  width?, height?, durationSec? }] }`
  → `{ uploadId, expiresAt, uploads: [{ mediaId, kind, url, method: "PUT",
  headers }] }`. Creates a `pending` post.
- **Phase 2:** client PUTs each file directly to MinIO using the presigned
  URLs.
- **Phase 3:** `POST /api/v1/posts/uploads/:uploadId/complete`
  → server `HEAD`s each object in MinIO, checks it exists and that
  size/content-type match, marks post `published`, fans out, returns the full
  post. Missing files → `409` with which `mediaId`s are missing; session
  stays open until expiry so the client can retry.
- `GET /api/v1/posts/uploads/:uploadId` — status (for app resume after
  restart).
- Limits: image post 1–10 images, ≤10 MB each, `image/jpeg|png|webp|heic`;
  video post exactly 1 video ≤100 MB (`video/mp4|quicktime`) plus optional 1
  thumbnail image. Upload session expires in 1 hour; expired sessions and
  their objects are cleaned up (lazily or by a script — builder's call).
- `DELETE /api/v1/posts/:id` — author only, soft delete, removed from feeds.

### 7.4 Feed
- `GET /api/v1/feed?cursor=&limit=` — reads `feed_item` for the caller,
  joined to post + author + media, newest first.
- Include the caller's own posts in their feed (fan-out writes to the author
  too).
- Each item: post, author summary, media with public URLs, `likeCount`,
  `commentCount`, `likedByMe`, latest 2 comments, `version`.
- Response: `{ items, nextCursor | null }`.

### 7.5 Post detail
- `GET /api/v1/posts/:id` — everything in a feed item plus author summary
  with follower count and `isFollowing`, full media metadata.
- `GET /api/v1/posts/:id/comments?cursor=&limit=` — oldest-first
  (builder may choose; document it).
- `GET /api/v1/posts/:id/likes?cursor=&limit=` — users who currently like it.
- Deleted post → `404` (or `410` — builder's call, document it).

### 7.6 Interactions (single)
Every mutating interaction accepts `clientOpId` (UUID) and
`clientTimestamp` (ISO).
- `PUT /api/v1/posts/:id/like` / `DELETE /api/v1/posts/:id/like`
- `POST /api/v1/posts/:id/comments` `{ id, text, clientOpId,
  clientTimestamp }` — `id` is the client-generated comment UUID, so an
  offline app can queue edits/deletes of a comment it created offline.
- `PATCH /api/v1/comments/:id` `{ text, baseVersion, clientOpId,
  clientTimestamp }`
- `DELETE /api/v1/comments/:id` `{ clientOpId }` (author only; post author
  may also delete — builder's call)

### 7.7 Batch sync
- `POST /api/v1/sync` `{ operations: [{ opId, type, postId?, commentId?,
  payload, clientTimestamp }] }` (max ~100 ops).
- Allowed op types (user's decision — likes and comments only):
  `like`, `unlike`, `comment.create`, `comment.edit`, `comment.delete`.
  Posts and follows are online-only.
- Processed in order; each op runs in its own transaction (one failing
  doesn't roll back others). A `comment.edit`/`comment.delete` whose comment
  doesn't exist (e.g. its `comment.create` was rejected earlier) is
  `rejected` with `COMMENT_NOT_FOUND`.
- Response: `{ results: [{ opId, status: "applied" | "duplicate" |
  "superseded" | "conflict" | "rejected", error?, canonical }] }` where
  `canonical` is the authoritative current state of the affected post
  (counts, `likedByMe`, `version`) and/or comment.

### 7.8 Cached post refresh (user's decision)
- `POST /api/v1/posts/refresh` `{ posts: [{ id, version }] }` (max ~200).
- Response: `{ updated: [fullFeedItem...], deleted: [postId...] }` —
  `updated` holds only posts whose server `version` differs from the one
  sent; `deleted` holds soft-deleted or unknown ids. Unchanged posts are
  omitted.
- Lets the offline-first app reconcile its cache on reconnect without
  refetching the whole feed. Comment edits/deletes bump the post `version`
  so they are picked up here.

## 8. Conflict resolution rules

The backend is the source of truth. Every interaction response — single or
batch — returns canonical state so the app overwrites its local copy.

1. **Idempotency.** `(userId, clientOpId)` is unique. A replay has no side
   effects and returns status `duplicate` with the **current** canonical
   state (re-read at replay time, never a stale snapshot), so the app always
   ends up on the latest server truth. Retries never create duplicate
   comments or double-count likes. Comment creates are additionally
   idempotent on the client-generated comment `id`.
2. **Likes — last write wins per (user, post).** Compare `clientTimestamp`
   against the stored `clientUpdatedAt`. Newer → apply (`applied`). Older →
   ignore (`superseded`) and return current state. Timestamps more than a
   small tolerance in the future are clamped to server time. Tie → server
   arrival order. `likeCount` changes only when `liked` actually flips.
3. **Comment create.** Always applied unless the post is deleted (`rejected`,
   code `POST_DELETED`) or op is a duplicate. `clientCreatedAt` is stored;
   ordering uses server `createdAt`.
4. **Comment edit.** Uses optimistic concurrency via `baseVersion`. If
   `baseVersion` equals current version → apply, bump version. If not →
   `conflict`, return current comment; client must take the server version.
   Edit of a deleted comment → `rejected` (`COMMENT_DELETED`).
5. **Comment delete.** Idempotent; deleting an already deleted comment is
   `applied`/no-op. Delete wins over any concurrent edit.
6. **Interactions on a deleted post** → `rejected` (`POST_DELETED`); app
   should drop the post locally.
7. **Versions.** `post.version` increments whenever like/comment counts,
   comment content (edit/delete), or the post itself change, so the app can
   tell if its cached copy is stale (see 7.8).
8. Counters are updated in the same transaction as the like/comment row.

## 9. Feed fan-out rules

- On publish (text post, or media post `complete`): insert `feed_item` for
  the author and every current follower, in the same transaction as
  publishing (fine at demo scale; note in docs that production would use a
  queue).
- On follow: backfill the followee's latest 50 published posts into the
  follower's feed.
- On unfollow: delete the followee's items from the unfollower's feed.
- On post delete: delete its `feed_item` rows.
- Cursor: opaque base64 of `(createdAt, postId)`; query uses keyset
  `WHERE (createdAt, postId) < (cursorCreatedAt, cursorPostId)`. Default
  limit 20, max 50. New posts arriving while scrolling never cause
  duplicates or gaps.
- Same cursor approach for all other paginated lists.

## 10. Media serving

- Bucket set up automatically on startup/compose (public-read policy for the
  media bucket, or presigned GET URLs — builder's call; public-read is
  simpler for the demo).
- Presigned PUT URLs must be reachable from a phone/emulator: the public
  MinIO base URL is configurable (`S3_PUBLIC_ENDPOINT`) separately from the
  internal endpoint. Document how to set it to the laptop's LAN IP.
- Object keys: `posts/{postId}/{mediaId}.{ext}`, `avatars/{userId}/...`.

## 11. Developer experience

- `docker compose up` brings Postgres + MinIO (+ bucket creation).
- `.env.example` with all variables.
- Scripts: `dev`, `build`, `start`, `db:generate`, `db:migrate`, `db:seed`,
  `db:reset`, `test`, `services:up`, `services:down`.
- **Terminal tool** (`npm run cli` or similar), a TypeScript interactive menu
  that calls these scripts: start/stop services, run migrations, seed demo
  data (with options such as number of users / posts, or reset-then-seed),
  start dev server, run tests, open Swagger URL. It is a thin wrapper — the
  logic lives in the scripts.
- **Seed:** ~10–20 users with known demo credentials (printed at the end),
  follow graph, mix of text/image/video posts using small sample media files
  committed to the repo (or generated), likes and comments, feeds populated
  via the same fan-out code path.
- Swagger UI at `/docs`, raw spec at `/openapi.json`, with bearer auth
  configured so you can "Authorize" and try endpoints.
- README: setup, demo credentials, architecture notes (fan-out, upload flow,
  conflict rules) suitable for talking through in an interview.

## 12. Testing

Integration tests against real Postgres (test database) and MinIO, covering:
- Signup/login and bearer-protected access.
- Text post + media post full flow (start → upload via presigned URL →
  complete), including incomplete-upload failure.
- Fan-out: follower sees post; follow backfills; unfollow removes; delete
  removes.
- Cursor pagination with no duplicates/gaps when new posts arrive mid-scroll.
- Conflict handling: duplicate opId, stale like superseded, comment edit
  version conflict, interaction on deleted post, batch sync mixed results
  (including create→edit→delete of an offline comment in one batch).
- Refresh endpoint returns only changed and deleted posts.

## 13. Calls made by Claude (not explicitly decided by the user)

- Batch `/sync` endpoint in addition to single endpoints.
- Soft delete for posts and comments.
- Profile fields: username, displayName, bio, avatar (avatar via presigned
  upload).
- Limits: 10 images or 1 video (+1 thumbnail) per post; 10 MB/image,
  100 MB/video; 1-hour upload session expiry.
- Feed includes the user's own posts.
- Follow backfill size: 50 posts.
- Fan-out done synchronously in-transaction (no queue).
- Like rows kept on unlike (`liked=false`) to support LWW.
- Comment edit uses version-based optimistic concurrency, not LWW.
- Media bucket is public-read for simple URL serving.
- Comment IDs are client-generated UUIDs (so offline edits/deletes can
  target offline-created comments).
- Duplicate replays return current canonical state, not a stored snapshot;
  the idempotency log stores only the original outcome.
- In `/sync`, an op targeting a missing comment is `rejected`
  (`COMMENT_NOT_FOUND`).
- Refresh endpoint caps at ~200 posts per call.

## 14. Left to the builder

Exact schema columns/types, library choices within the stack (validation,
CLI prompt library, test runner), folder structure, error code catalogue,
comment ordering direction, 404 vs 410 for deleted posts, user search, how
expired upload sessions are cleaned up.
