# NewsFeed API

Backend for a mobile news-feed app (Instagram/Facebook style): text, image and video posts, follows, a
pre-computed home feed, likes and comments, and offline-friendly sync with deterministic conflict
resolution. Hono + zod-openapi, Better Auth, Postgres (Drizzle), and any S3-compatible object store
(RustFS in development). Everything runs locally with Docker; no cloud account or internet is needed at runtime.

## Prerequisites

- Node 24
- Docker (Postgres 17 and RustFS run via `docker compose`)

## Quick start

```bash
npm i
cp .env.example .env
npm run cli        # choose "Full setup"
```

"Full setup" starts the services, runs migrations, seeds demo data (12 users, 6 posts each) and starts the
dev server. The CLI menu also has: start/stop services, migrate, seed, reset database, dev server, run tests, show URLs.

Without the CLI: `npm run services:up && npm run db:migrate && npm run db:seed -- --reset && npm run dev`.

| What | URL |
| --- | --- |
| API | http://localhost:3000 |
| Swagger UI | http://localhost:3000/docs |
| OpenAPI spec | http://localhost:3000/openapi.json |
| Storage console (RustFS) | http://localhost:9001 (`rustfsadmin` / `rustfsadmin`) |

If port 3000 is already in use, set `PORT` (and `BETTER_AUTH_URL` to match), e.g. `PORT=3100 npm run dev`.

### Object storage

Media lives in an S3-compatible store. The compose file runs **RustFS** (MinIO no longer publishes pullable
images): S3 API on port 9000, console on 9001, credentials `rustfsadmin` / `rustfsadmin`. A one-shot
`amazon/aws-cli` container creates the public-read bucket `newsfeed-media`. The code only uses the AWS S3 SDK,
so any S3-compatible store works by changing the `S3_*` variables in `.env`.

### Demo credentials

The seed creates `demo1@newsfeed.dev` ... `demoN@newsfeed.dev` (usernames `demo1`...), all with password `password123`.

## Authenticating

Auth is [Better Auth](https://www.better-auth.com) mounted at `/api/auth/*`. Only four of its endpoints are
exposed: `POST /sign-up/email`, `POST /sign-in/email`, `POST /sign-out` and `GET /get-session`; every other
`/api/auth/*` path returns 404. Profile changes go through `PATCH /api/v1/me` and the avatar upload flow.

Sign-up requires `email`, `password`, `name` (1-60 characters) and `username`. The username is lowercased,
then must match `^[a-z0-9_]{3,30}$` (the same rule as `PATCH /me`). `bio` and `image` are rejected at sign-up
with 400; set them later with `PATCH /me` and the avatar flow.

```bash
# Sign up
curl -s -X POST http://localhost:3000/api/auth/sign-up/email -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"password123","name":"Me","username":"me"}'

# Sign in, and read the bearer token from the set-auth-token response header
curl -si -X POST http://localhost:3000/api/auth/sign-in/email -H 'content-type: application/json' \
  -d '{"email":"demo1@newsfeed.dev","password":"password123"}' | grep -i '^set-auth-token'

# Call the API
curl -s http://localhost:3000/api/v1/feed -H "Authorization: Bearer $TOKEN"
```

The token comes back in the `set-auth-token` response header (also exposed through CORS, so browser and
mobile clients can read it) and is sent as `Authorization: Bearer <token>`. In Swagger UI: run
`POST /api/auth/sign-in/email`, copy the `set-auth-token` response header (or the `token` field of the body),
click **Authorize** and paste it.

## Error format

Every `/api/v1` error is `{ "error": { "code": string, "message": string, "details"?: unknown } }`, e.g.
`401 UNAUTHORIZED`, `400 VALIDATION_ERROR`, `400 INVALID_CURSOR`.
Errors from Better Auth's own routes (`/api/auth/*`) use Better Auth's format instead, not this shape.

## Testing on a phone

A phone cannot reach `localhost`, and presigned media URLs and Better Auth must advertise an address it can reach.
Set these in `.env` (use your machine's LAN IP) and restart the server:

```
S3_PUBLIC_ENDPOINT=http://<LAN-IP>:9000
BETTER_AUTH_URL=http://<LAN-IP>:3000
```

Switching `S3_PUBLIC_ENDPOINT` needs no reseed: posts store media object keys and users store avatar object keys,
and every `url` / `avatarUrl` is built from the current endpoint when it is read. (Better Auth's own
`/api/auth/*` responses show the raw key in `user.image`; use `avatarUrl` from `/api/v1`.)

## Endpoint overview

All routes below are under `/api/v1` and require a bearer token. Full schemas and examples are in `/docs`.

| Tag | Endpoint | Purpose |
| --- | --- | --- |
| Users | `GET /me`, `PATCH /me` | Own profile |
| Users | `POST /me/avatar/upload-url`, `POST /me/avatar/complete` | Avatar upload (presigned) |
| Users | `GET /users?search=`, `GET /users/{id}` | Search, profile with counts |
| Follows | `PUT/DELETE /users/{id}/follow` | Follow (backfills 50 posts) / unfollow |
| Follows | `GET /users/{id}/followers`, `GET /users/{id}/following` | Paginated lists |
| Posts | `POST /posts` | Text post, idempotent on `clientOpId` |
| Posts | `GET /posts/{id}`, `DELETE /posts/{id}` | Detail, soft delete (author only) |
| Posts | `GET /posts/{id}/comments`, `GET /posts/{id}/likes` | Paginated |
| Posts | `GET /users/{id}/posts` | A user's posts |
| Posts | `POST /posts/refresh` | Refresh cached posts (see below) |
| Uploads | `POST /posts/uploads`, `POST /posts/uploads/{uploadId}/complete`, `GET /posts/uploads/{uploadId}` | Image/video post upload |
| Feed | `GET /feed` | Home feed |
| Interactions | `PUT/DELETE /posts/{id}/like` | Like / unlike |
| Interactions | `POST /posts/{id}/comments`, `PATCH/DELETE /comments/{id}` | Comment create / edit / delete |
| Sync | `POST /sync` | Batch of up to 100 offline operations |

Limits: image post 1-10 images, each up to 10 MB (jpeg/png/webp/heic); video post exactly 1 video up to 100 MB
(mp4/quicktime) plus an optional thumbnail. Pagination everywhere: `limit` default 20, max 50, response
`{ items, nextCursor }`. Posts and comments are soft-deleted.

Avatar: `POST /me/avatar/upload-url` returns an `avatarKey` (`avatars/<your id>/<uuid>.<ext>`) and a presigned
`PUT` URL. `POST /me/avatar/complete` with that key returns `400 VALIDATION_ERROR` for a malformed key,
`403 FORBIDDEN` for another user's key, `409 UPLOAD_INCOMPLETE` if nothing was uploaded, and
`422 MEDIA_MISMATCH` if the stored object is not a jpeg/png/webp/heic image of at most 10 MB.

IDs are UUIDs and are case-insensitive: uppercase ids (e.g. iOS `UUID().uuidString`) are accepted and responses
always use lowercase.

## Architecture notes

### Two-phase presigned upload

Media bytes never pass through the API.

1. `POST /posts/uploads` declares the files (kind, content type, size). The server validates the declaration,
   creates a **pending** post and media rows, and returns one presigned `PUT` URL per file plus an `uploadId`
   (valid for 1 hour).
2. The client `PUT`s each file straight to object storage, with the returned headers.
3. `POST /posts/uploads/{uploadId}/complete` `HEAD`s every object and compares size and content type with the
   declaration, then publishes the post and fans it out, all in one transaction.

Failure modes: a file that was never uploaded gives `409 UPLOAD_INCOMPLETE`; a file that differs from the
declaration gives `422 MEDIA_MISMATCH`; both name the media ids and leave the post unpublished so the client can
re-upload and retry. `complete` is idempotent: calling it again returns the same published post with 200. After
the hour is up it returns `410 UPLOAD_EXPIRED` and the pending post and media are cleaned up, so any further call
returns `404`. Pending posts are invisible everywhere (feed, profiles, detail, comments, refresh).
`GET /posts/uploads/{uploadId}` reports which files are already uploaded so an interrupted upload can resume.

### Feed fan-out on write

When a post is published (text post, or media post `complete`), a `feed_item` row is inserted for the author and
every current follower, **synchronously inside the publish transaction**. Reads are then a single indexed keyset
query on the reader's own feed rows. Follow backfills the followee's latest 50 published posts into your feed,
unfollow removes their posts from it, and deleting a post removes its feed rows.
This is fine at demo scale. In production fan-out would move to a queue and worker, so a post by an account with
millions of followers does not make the publish request slow or hold a long transaction (and very large accounts
are usually handled with fan-out on read).

### Keyset pagination

Cursors are opaque base64url of a `(timestamp, id)` pair and queries use
`WHERE (created_at, id) < (cursor_ts, cursor_id) ORDER BY created_at DESC, id DESC`. Posts arriving while the
user scrolls never cause duplicates or gaps, and cost does not grow with page depth (unlike `OFFSET`). A malformed
or tampered cursor returns `400 INVALID_CURSOR`.

### Offline sync and conflict rules

The backend is the source of truth. Every interaction response, single or batch, returns **canonical state**
(`OpResult.canonical`) that the app should overwrite its local copy with. `POST /sync` applies operations
sequentially in order, so a comment can be created, edited and deleted in one batch. The single-interaction
endpoints use exactly the same code path.

| Rule | Behaviour |
| --- | --- |
| Idempotency | `(userId, clientOpId)` is unique. A replay has no side effects and returns `duplicate` with the **current** canonical state (re-read at replay time, not a stored snapshot). Concurrent replays produce exactly one effect. |
| Likes | Last write wins per (user, post) by `clientTimestamp`. Newer: `applied`. Older: `superseded`, current state returned. Timestamps more than 60 s in the future are clamped to server time, so a wrong phone clock cannot lock the like state. `likeCount` changes only when the state actually flips. |
| Comment create | Always `applied` unless the post is deleted (`rejected`, `POST_DELETED`) or it is a duplicate. Comment ids are **client-generated UUIDs**, so offline edits and deletes can target comments that were themselves created offline. Ordering uses server `createdAt`. |
| Comment edit | Optimistic concurrency on `baseVersion`. Equal to the current version: apply and bump. Otherwise `conflict` with the current comment; the client takes the server version. Editing a deleted comment: `rejected` (`COMMENT_DELETED`). Only the author may edit. |
| Comment delete | Idempotent; deleting an already deleted comment is a no-op `applied`. Delete wins over any concurrent edit. Allowed for the comment author and the post author. |
| Deleted post | Any interaction is `rejected` (`POST_DELETED`); the app should drop the post locally. |
| Versions | `post.version` increments when counts, comment content or the post itself change, so a client can tell its cached copy is stale. Counters change in the same transaction as the like/comment row. |

`OpResult.status` is one of `applied`, `duplicate`, `superseded`, `conflict`, `rejected`. Single-interaction
endpoints map it to HTTP status (200 for applied/duplicate/superseded, 201 for a newly created comment, 4xx for
conflict/rejected); `/sync` always returns 200 with one result per operation.

### Refresh endpoint

`POST /posts/refresh` takes up to 200 cached `{ id, version }` pairs and returns `updated` (full current state of
posts whose version changed) and `deleted` (ids that were deleted or are no longer visible). A client can
revalidate an entire cached screen in one round trip.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run cli` | Interactive menu for all dev tasks |
| `npm run services:up` / `services:down` | Start / stop Postgres and RustFS |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed -- --reset` | Seed demo data (`--users=N --posts=N`) |
| `npm run db:reset` | Drop all tables, re-run migrations and empty the media bucket; refuses non-local hosts unless `ALLOW_DB_RESET=1` |
| `npm run dev` / `npm start` | Dev server (watch) / plain server |
| `npm test` | Vitest suite (uses a separate `newsfeed_test` database; needs services running) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run media:generate` | Regenerate the sample media in `scripts/sample-media` |
