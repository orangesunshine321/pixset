# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lumina is a self-hosted, single-admin alternative to Pixieset: a photographer uploads a batch of exported JPEGs to a gallery, shares a link (with an optional password) with a client, the client browses and favorites photos with no account required, and the photographer pulls the favorited filenames back into Lightroom Classic via a one-click clipboard export (paste into Lightroom's Library Filter, Filename field, "Any" match). See `README.md` for the user-facing product docs (setup, hosting, backups, troubleshooting).

## Commands

```bash
npm run dev            # runs the Vite dev server (web) and Fastify dev server (API) concurrently
npm run dev:web         # Vite only, port 5173, proxies /api to :3000
npm run dev:server      # Fastify only (tsx watch), port 3000
npm run build            # vite build -> dist/web (production frontend bundle)
npm start                 # NODE_ENV=production tsx src/server/index.ts (runs the server from source, no compile step)
npm run typecheck          # tsc --noEmit across both src/server and src/web
npm run db:generate         # drizzle-kit generate — diffs db/schema.ts against drizzle/ and writes a new migration
npm run db:migrate           # tsx src/server/db/migrate.ts — applies pending migrations (also runs automatically on container boot)
npm test                      # vitest run — integration + unit tests in src/server/__tests__/
                              # (vitest.config.ts, not vite.config.ts, configures these: forks pool,
                              #  per-file temp DATA_DIR set before dynamic-importing config/db)
```

There is no server build/compile step. The server runs directly from TypeScript source via `tsx` in both dev and production (see "Runtime model" below) — only the frontend goes through a Vite build.

After changing `src/server/db/schema.ts`, run `npm run db:generate` to produce a new migration file in `drizzle/`, then `npm run db:migrate` to apply it locally.

## Architecture

### Runtime model: one process, no build step for the server

The server is executed directly from `.ts` source by `tsx` (a production dependency, not just a dev tool) — there's deliberately no `tsc`-to-`dist` compile step for the backend. This is a conscious simplification for a solo-maintained app: fewer moving parts than the alternative (bundling native deps like `sharp`/`better-sqlite3` is awkward anyway). Only the frontend (`src/web`) goes through a real build (`vite build` → `dist/web`), which the server serves via `@fastify/static` in production (`src/server/app.ts`).

Background work (image processing, DB backups, session/rate-limit cleanup) all runs as `setInterval`/self-scheduling loops **inside the same Node process** that serves HTTP — there is no separate worker container, queue service, or cron. See `src/server/index.ts` for where these are started (`startWorker`, `startMaintenanceSweep`, `startBackupSweep`).

### Two distinct, deliberately different auth systems

- **Admin auth** (`src/server/services/auth.ts`, `routes/setup.ts`, `routes/admin/auth.ts`): DB-backed sessions (`admin_sessions` table, opaque token hashed with SHA-256 before storage). There's no signup route — the *only* way an admin account is created is the self-disabling `/api/setup` route, which checks `admin_users` is empty on every request rather than caching that fact. Gated by the `requireAdmin` preHandler (`src/server/middleware/requireAdmin.ts`). Two ways in, one session system: password (+ optional TOTP) or a **WebAuthn passkey** (`services/passkeys.ts`, `routes/admin/passkeys.ts` — `@simplewebauthn`, discoverable credentials with user verification required, so a passkey login is inherently two-factor and deliberately never prompts for TOTP; both paths mint the identical `admin_sessions` row). Passkey ceremony state is an in-memory single-use challenge map (same one-process reasoning as the worker — a restart mid-ceremony just means retrying), and the relying party is derived per-request from the request's own origin, which is safe because credentials are browser-scoped to the RP ID and every response is signature-checked against the stored public key. Passkey login joins `admin_passkeys` against `admin_users` (like `verifyAdminSession`) so rows orphaned by the sqlite3-CLI account reset — which runs with foreign keys OFF — can never authenticate.
- **Gallery access** (`src/server/services/photoAccess.ts`, `routes/gallery/public.ts`): stateless signed JWT cookies (via `jose`), one reason being that a single browsing session can trigger hundreds of photo-byte requests and a DB lookup per request would be wasteful. The cookie carries `{galleryId, passwordVersion}`; bumping `galleries.passwordVersion` on any password set/change/removal instantly invalidates every previously-issued cookie for that gallery with zero server-side session state. Gated by the `requireGalleryAccess` preHandler, used on every `/api/gallery/:slug/*` route that requires the caller to have already passed the password gate.

Both the `/api/admin/login` and `/api/gallery/:slug/unlock` routes follow the same anti-enumeration pattern: a real Argon2id hash of a throwaway value is computed once at module load (`DUMMY_HASH`) and verified against even when the target account/gallery doesn't exist, so response timing doesn't leak which case occurred, and both "wrong password" and "doesn't exist" return an identical response shape/status.

Rate limiting (`src/server/services/rateLimiter.ts`) is backed by the `auth_attempts` table, not an in-memory counter or Redis — it needs to survive process restarts. It combines a per-`(scope, ip)` exponential backoff with a coarser per-gallery cap across all IPs (blunts a distributed low-and-slow attack against one gallery link).

### Photo byte serving is one unified, independently-checked route

`src/server/routes/photos.ts` (`GET /api/photos/:photoId/:variant`) is the *only* place photo bytes are ever served — the admin grid, the client gallery, and the lightbox all point at it. Every request independently re-resolves the photo → its gallery → checks (admin session) OR (gallery has no password) OR (valid gallery-access cookie matching that gallery), before streaming from disk. Unguessable IDs (`nanoid`, see `lib/ids.ts`) are defense-in-depth on top of this check, never a substitute for it — don't rely on ID obscurity alone when adding new photo-serving paths.

### Image processing: the `photos.status` column *is* the job queue

There's no separate jobs table or queue library (no BullMQ/pg-boss/Redis). `src/server/services/worker.ts` polls `photos` for `status = 'pending'` rows, atomically claims a batch by flipping them to `'processing'`, and processes concurrently up to `config.uploadConcurrency`. On boot, any row still `'processing'` (from a prior crash) is reclaimed back to `'pending'` before the loop starts. Progress is broadcast via a plain Node `EventEmitter` (`progressBus`, exported from `worker.ts`) that SSE routes (`routes/admin/uploads.ts`'s `/photos/stream`) subscribe to, filtering by `galleryId`.

`src/server/services/imagePipeline.ts` does the actual per-photo work: four WebP derivatives (`thumb`/`thumb2x`/`preview`/`preview2x`, sized/quality-tuned per variant) via `sharp`, a ThumbHash placeholder (`thumbhash` package — encoded as base64 for DB storage/API transport; see `computeThumbHash`), and best-effort EXIF `DateTimeOriginal` extraction via `exifr` (imported as a **default import** — its CJS build only exposes a default export under Node's native ESM loader, unlike bundler-based tooling which is more lenient about this).

### Storage layout

`src/server/lib/storage.ts` centralizes all on-disk paths (originals, derived variants, per-gallery directories) — always use its helpers (`originalPath`, `derivedPath`, `ensureGalleryDirs`, `deleteGalleryFiles`) rather than constructing paths inline, so the layout stays consistent across the upload route, the image pipeline, the photo-serving route, and gallery deletion. Root paths come from `src/server/config.ts`, which reads `DATA_DIR`/`DATABASE_PATH`/`PHOTOS_PATH` env vars (set in `docker-compose.yml`; `.env.example` only holds the operator-facing secrets/tuning knobs).

### Frontend: shared DTOs are the client-server contract

`src/web/lib/types.ts` defines the DTO shapes (`GalleryDTO`, `PhotoDTO`, `PhotoListResponse`, etc.) that the frontend treats as the source of truth for API response shapes — server route handlers build plain objects matching these shapes (each route file defines its own `toDTO`/`toPhotoDTO` mirror rather than importing from `web/`, since server code doesn't depend on frontend code). Always build photo image URLs via the `photoUrl(photoId, variant)` helper (or the equivalent `urls` object already present on a `PhotoDTO` from the API) rather than constructing `/api/photos/...` paths inline.

The app is two route trees under one Vite entry (`src/web/main.tsx` → `App.tsx`): `/admin/*` (`routes/admin/AdminApp.tsx`) and `/g/:slug/*` (`routes/gallery/GalleryApp.tsx`), both lazy-loaded (`React.lazy`) so a client viewing a gallery never downloads the admin bundle. Each admin gallery-detail page (`routes/admin/GalleryDetail.tsx`) composes several independent, self-contained panel components (`GallerySettingsPanel`, `UploadPanel`, `AdminPhotoGrid`, `LightroomExportPanel`, `DownloadButtons`) that each own their own data fetching — `GalleryDetail.tsx` itself only fetches the gallery record and passes `galleryId`/`gallery` down.

Favorites are a single set **per gallery**, not per visiting device/browser (`UNIQUE(gallery_id, photo_id)` in the schema) — this is intentional: the product need is one consolidated pick list to export to Lightroom, so a client switching from phone to laptop must see the same picks, not a second independent set.

### Photo sets: an opt-in grouping layer with two independent client toggles

A gallery's photos can be grouped into named **sets** (`photo_sets` table; `photos.setId` nullable FK `ON DELETE SET NULL`, so deleting a set orphans its photos back to ungrouped rather than deleting them). Sets are opt-in: a gallery with no sets has every photo `setId = NULL` ("ungrouped") and behaves exactly as before. Each set carries **two independent** booleans — `visibleToClient` and `allowDownloads` — so a "Raws" set can be visible-but-not-downloadable (proofing) or hidden entirely (admin-only). The effective client rule, applied identically in **every** client-facing path: an ungrouped photo is always visible and downloadable iff `gallery.allowDownloads`; a set photo is visible iff `visibleToClient` and downloadable iff (`visibleToClient AND set.allowDownloads`); admins bypass both. Enforce this in **all** of: `routes/photos.ts` (hidden-set photo → 404 for non-admins before any file access; original gated per-set), `routes/gallery/public.ts` (landing counts/`sets[]` exclude hidden and never leak a locked gallery's set names; `/photos` list excludes hidden + supports `?setId`; favorite toggle rejects hidden; `/download`), and `services/zip.ts` `collectZipEntries()` (the ONE place download selection + set permissions live — pass `visibleOnly`/`downloadableOnly`/`galleryAllowDownloads`; `streamPhotoZip()` folder-namespaces by set title with per-folder filename dedup). The gallery-wide `sortIndex` is unchanged — sets are a filter over the existing global order, so cursor pagination keeps working. Favorites stay gallery-wide (never partition by set). Set management is `routes/admin/sets.ts` (all admin-gated); uploads may target a set via `?setId`.
