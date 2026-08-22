# Lumina

**Self-hosted client photo proofing with a one-click Lightroom pick-list export — a lean alternative to Pixieset.**

Upload a batch of exported JPEGs, share a private gallery link with your client (with an optional password), let them favorite photos with no account required, then pull those picks straight back into Lightroom Classic to flag for editing. That's the whole product — one workflow, done well, running entirely on your own hardware.

> **Not a developer?** Start with **[GETTING_STARTED.md](GETTING_STARTED.md)** — a plain-English, ten-minute setup with no jargon.
> **Putting it on the internet?** See **[DEPLOYMENT.md](DEPLOYMENT.md)** — Cloudflare Tunnel, Tailscale, or a VPS, with a pre-flight security checklist.

## Contents

- [Features](#features)
- [What it deliberately isn't](#what-it-deliberately-isnt)
- [Quick start](#quick-start)
- [The Lightroom workflow](#the-lightroom-workflow)
- [Configuration](#configuration)
- [Backups](#backups)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [How it's built](#how-its-built)
- [License](#license)

## Features

**For you (the photographer):**

- Create a gallery per shoot and **bulk-upload** exported JPEGs by drag-and-drop, with live per-file and overall progress. Thumbnails and previews are generated in the background, so the grid fills in as you watch — no waiting for the whole batch. Interrupted mid-upload? Re-select the same folder; already-uploaded files are detected and skipped.
- **Manage photos** in place: review any shot full-size in a lightbox, delete in bulk, retry failed processing, set a **cover photo**, and re-sort the whole gallery by **capture time** (fixes interleaved multi-camera shoots) or filename.
- **The Lightroom pick-list export** — the headline feature. One click copies your client's favorites as a filename list you paste into Lightroom's Library Filter. [How it works ↓](#the-lightroom-workflow)
- **Know when picks are ready** — clients tap "Send my picks" (with an optional note) to submit their selection; you get a "Picks ready" badge and can be pinged on a webhook (Discord, Slack, ntfy). No more guessing whether they're done.
- **Account management** built in: change your email or password (which signs out every other device), sign out everywhere, or turn on two-factor authentication.
- **Passkey sign-in** — add a passkey (Touch ID, Face ID, a device PIN, or a security key) from Account settings and sign in with one tap: no password typed, no authenticator code, nothing to forget. Works entirely self-hosted — no Google/Apple account involved, WebAuthn is built into every modern browser. Your password stays as a fallback.
- **Automatic backups** of the database daily, plus on-demand snapshots you can download straight from the dashboard.

**For your client (no account, ever):**

- A fast, responsive gallery — **dark by default**, with a light option — built around a justified photo grid and a full-screen lightbox with pinch-to-zoom.
- **Favorite** photos with a tap; picks persist across visits and devices with no login. A **Favorites filter** lets them review just their selections, and a **Send my picks** button submits the final set to you.
- Optional **downloads**, off by default and enabled per gallery: full-resolution originals, individually or as a zip.

**For hosting:**

- **Zero-config setup** — no `.env` required; the cookie-signing secret is generated and persisted on first boot.
- **One command to install *or* update**, with your photos and database never touched on update.
- Runs as a **single Docker container** as an **unprivileged user**, with **no third-party requests** of any kind (fonts and assets are self-hosted — client galleries phone home to nobody).

## What it deliberately isn't

No e-commerce or print store, no invoicing, no multi-user or team accounts (there's exactly one admin — you), no proofing comments, no watermarking, and no Lightroom plugin or catalog/XMP writing. The Lightroom "integration" is a clipboard button and nothing more. Keeping the scope this tight is the point.

## Quick start

Requires [Docker](https://docs.docker.com/get-docker/) with Compose v2 (bundled with Docker Desktop and modern Docker Engine).

**One-line install** (also the update command — safe to re-run):

```bash
curl -fsSL https://raw.githubusercontent.com/orangesunshine321/lumina/main/install.sh | bash
```

This installs into `./lumina`, pulls the prebuilt image, starts the app, and waits until it's healthy. Re-running it later **updates in place** — your `./data` directory (photos, database, backups) is never touched.

**Or manually:**

```bash
git clone https://github.com/orangesunshine321/lumina.git && cd lumina
docker compose up -d
```

Then open **`http://localhost:7373`** and complete the one-time setup form. It asks for a **setup code**, which the installer prints (also available with `docker compose logs app | grep "SETUP CODE"`) — this stops anyone else from claiming the admin account, which matters if the app is already reachable on a public URL. Database migrations run automatically on every start.

The default port is **7373** (chosen to avoid commonly-taken dev ports); if it's busy the installer prompts for another. Set one up front with `curl … | LUMINA_PORT=4444 bash`, choose the location with `LUMINA_DIR=…`, or change it later via `LUMINA_PORT` in `.env`.

To share galleries beyond your own network, **[DEPLOYMENT.md](DEPLOYMENT.md)** walks through Cloudflare Tunnel (free, no port forwarding — a one-command `docker compose --profile tunnel up -d` once you paste a token), Tailscale, and VPS + reverse-proxy setups.

## The Lightroom workflow

On a gallery's detail page, the **Lightroom export** panel lists every favorited photo and a **Copy Lightroom List** button. It copies the favorites' original filenames (extension stripped) as a comma-separated list:

```
DSC_1001, DSC_1014, DSC_1032, DSC_1058
```

In Lightroom Classic:

1. Open the Library module and the Filter bar (`\` toggles it).
2. Choose **Text** search → field **Filename** → match **Any**. (Not "Contains" — **Any** matches every filename in one paste.)
3. Paste. Every pick is now selected — flag them, label them, or start editing.

No plugin, no sidecars, no catalog scripting — just the clipboard and Lightroom's own filter bar.

## Configuration

Everything is optional. To override a default, copy `.env.example` to `.env` and uncomment what you need:

| Variable | Default | Notes |
|---|---|---|
| `LUMINA_PORT` | `7373` | Host port the app is reachable on. Change any time, then `docker compose up -d`. |
| `SESSION_SECRET` | auto-generated | Signs gallery-access cookies. Generated and persisted to `./data/db/session-secret` on first boot; set it yourself only to manage/rotate the key. Changing it logs every client out of every gallery. |
| `UPLOAD_CONCURRENCY` | `4` | How many photos process concurrently in the background. Lower it on low-core/low-RAM hardware — image processing is the main memory consumer. |
| `MAX_UPLOAD_FILE_SIZE_BYTES` | `52428800` (50 MB) | Per-file upload size limit. |

There is deliberately no `ADMIN_EMAIL`/`ADMIN_PASSWORD` — the admin account is created once through the setup form, which permanently disables itself the instant an account exists.

## Backups

**The database backs itself up automatically** — a consistent, no-downtime snapshot is written to `data/db/backups/` at startup and every 24 hours, keeping the last 14 daily copies. If it ever stalls, a banner appears in the admin UI. You can also trigger a snapshot and **download it** from the dashboard's system panel — the easiest way to keep an off-box copy.

**Photo files are not in that snapshot** (they're large, and derivatives regenerate from originals) — but favorites and gallery metadata have no other copy anywhere, which is why the database backup is automatic. For full disaster recovery, back up the whole `./data` directory yourself. [restic](https://restic.net/) is a good fit:

```bash
export RESTIC_REPOSITORY=/mnt/backup-drive/lumina-restic
export RESTIC_PASSWORD=<a-strong-password-you-store-somewhere-safe>
restic init                          # once, ever
restic backup /path/to/lumina/data   # on a schedule, e.g. nightly cron
restic forget --keep-daily 14 --keep-weekly 8 --prune
```

**Restore:** stop the container, replace `./data` with your backup (or just `data/db/` plus `data/photos/originals/` — derivatives regenerate on boot), start again.

## Updating

Re-run the [one-line installer](#quick-start) — it pulls the latest image and leaves your data alone. From a manual clone instead:

```bash
git pull && docker compose pull && docker compose up -d
```

Migrations run automatically on start. Tagged releases publish a prebuilt multi-arch image to GitHub Container Registry (`ghcr.io/orangesunshine321/lumina`), which is what the installer and `docker compose pull` fetch — no local build needed.

## Troubleshooting

**Forgot the admin password.** While signed in, change it any time from the account menu — and consider adding a **passkey** (Account settings → Passkeys) so future sign-ins don't depend on remembering it at all. If you're fully locked out, there's no email reset (single-admin tool by design) — reset the account with:

```bash
docker compose exec app sh -c 'sqlite3 /data/db/app.sqlite "DELETE FROM admin_sessions; DELETE FROM admin_passkeys; DELETE FROM admin_users;"'
```

Reload the app and the setup form reappears. Galleries, photos, and favorites are untouched — only the login is reset. (All three tables are cleared because the sqlite3 CLI doesn't enforce foreign keys, so old sessions and passkeys would otherwise be orphaned — an orphaned passkey can't sign in, but your browser would still offer it. Re-add your passkeys from Account settings afterwards.)

**Port already in use.** Set `LUMINA_PORT` in `.env` (e.g. `LUMINA_PORT=4444`) and run `docker compose up -d`. The installer handles this automatically on fresh installs.

**Permission errors on `./data`.** The container fixes ownership of its data volume automatically on start. If you need it to run under a specific host UID, add `user: "1000:1000"` to the `app` service and `chown -R 1000:1000 ./data` once beforehand.

## How it's built

- **Backend:** Fastify + SQLite (via Drizzle ORM) + sharp for image processing, run directly from TypeScript by `tsx` — there's no server compile step.
- **Frontend:** a React + Vite single-page app (no SSR — private galleries have no SEO value). Self-hosted variable fonts, no external assets.
- **One process, one container:** background image processing, backups, and cleanup all run as loops inside the same Node process that serves HTTP. No Postgres, no Redis, no separate worker, no required cloud dependency.
- **Two auth systems by design:** DB-backed sessions for the single admin (reachable by password or passkey — both mint the same revocable session); stateless signed cookies for gallery access, so a password change instantly invalidates every previously issued link.

For the full architecture and rationale, see **[CLAUDE.md](CLAUDE.md)**.

### Development

```bash
npm install
npm run dev         # Vite (web, :5173) + Fastify (API, :3000) together, hot-reloading
npm test            # vitest — integration + unit tests
npm run typecheck   # tsc --noEmit across server and web
npm run build       # production frontend bundle → dist/web
```

The server runs from source via `tsx` in both development and production; only the frontend is bundled. After changing `src/server/db/schema.ts`, run `npm run db:generate` then `npm run db:migrate`.

## License

ISC — see [LICENSE](LICENSE).
