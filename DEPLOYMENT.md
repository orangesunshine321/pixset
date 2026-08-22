# Putting Lumina on the internet

Lumina only ever speaks plain HTTP on one local port. To share galleries beyond
your own machine, put one of these in front of it. All three give you HTTPS
without touching certificates yourself.

> **Easier: use the in-app wizard.** Sign in, open the account menu → **Public
> access & domain**. It sets your public URL, runs a connectivity self-test,
> shows your current proxy/TLS status, and generates the exact config/commands
> for each option below — pre-filled with your domain. For Cloudflare it can go
> further and create the tunnel + DNS for you from an API token (used once,
> never stored), then hand you the one command to run. The steps below are the
> manual equivalent, and are what the wizard produces.

## Option A — Cloudflare Tunnel (recommended)

No port forwarding, no public IP needed, free, and works identically on a home
NAS or a cloud server. Traffic reaches Cloudflare over an outbound connection
from the container.

1. In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/)
   go to **Networks → Tunnels → Create a tunnel** (Cloudflared type), name it
   `lumina`, and copy the token it shows you.
2. In your Lumina folder, add the token to `.env`:
   ```
   CLOUDFLARE_TUNNEL_TOKEN=eyJh...
   ```
3. In the tunnel's **Public Hostname** tab, add your hostname (e.g.
   `photos.yourdomain.com`) with service **HTTP** → `app:3000`.
   (`app:3000` is Lumina's address *inside* the compose network — use it
   exactly, not localhost or 7373.)
4. Start Lumina with the tunnel profile:
   ```bash
   docker compose --profile tunnel up -d
   ```

Your galleries are now at `https://photos.yourdomain.com`. Cloudflare
terminates TLS and forwards the real visitor IP, which Lumina's rate limiting
uses (`TRUST_PROXY` is already set).

## Option B — Tailscale (private by default, public if you choose)

Best when galleries are for a handful of people and you'd rather not expose
anything publicly. Install [Tailscale](https://tailscale.com/download) on the
host machine, then:

```bash
# HTTPS URL reachable by devices on YOUR tailnet only (clients need Tailscale):
tailscale serve --bg 7373

# OR a genuinely public HTTPS URL through Tailscale's relay (no client needed):
tailscale funnel 7373
```

Both print the URL to share. `serve` is the safer default; `funnel` behaves
like normal public hosting. Adjust the port if you changed `LUMINA_PORT`.

## Option C — a VPS with Caddy

Rent a small VPS (any provider, ~$5/mo), install Docker, run the same
one-line installer, then put Caddy in front — see the reverse-proxy section in
the README for the 3-line Caddyfile. Point your domain's DNS at the VPS first
so Caddy can issue certificates.

## Home server vs. a cloud server

Both work, and switching between them needs zero code changes — same image,
same compose file, same `./data` layout. The one thing worth knowing: on a
home connection, your **upload** bandwidth is shared between your own photo
uploads *and* every client browsing a gallery, and most home connections are
far slower up than down. So if galleries feel sluggish for clients, that's
almost always why — not the app.

If that becomes a problem, move to a small VPS. Your one-time upload of a shoot
still rides your home connection but happens once, in the background; every
client view afterward is served from the VPS's much faster, usually symmetric
bandwidth. Cloudflare Tunnel (Option A) works identically in both places, so
the move is just: install on the VPS, copy your `./data` over, done.

## Verifying without a domain

To confirm Lumina works end-to-end over a real public URL before committing a
domain, run a Cloudflare **quick tunnel** — no account, token, or domain
needed. Alongside a running Lumina:

```bash
docker run --rm --network <your-compose-network> cloudflare/cloudflared:latest \
  tunnel --no-autoupdate --url http://app:3000
```

It prints a temporary `https://<random>.trycloudflare.com` address that proxies
to your instance. Every code path a real deployment uses — HTTPS, secure
cookies, the setup code, galleries, favorites, downloads — runs over it. (This
exact test is part of how each release is validated.)

## Security checklist before going public

Lumina is designed to sit on the open internet behind any of the above, but
run down this list once:

- [ ] **Set a password on any gallery you'd mind strangers seeing.** Links are
      unguessable (125-bit random), but links get forwarded — a password is
      the second lock. You can also mint a fresh link per gallery at any time
      ("Get a new link" in gallery settings) if one escapes.
- [ ] **Client downloads stay off unless you enable them** per gallery —
      browsing never exposes your full-resolution originals.
- [ ] **Use a strong admin password** (12+ characters is enforced; make it a
      real passphrase). Change it any time from the account menu; that signs
      out every other device.
- [ ] **Turn on two-factor authentication** (Account settings → Two-factor)
      if the app is reachable from the internet. It adds a code from any
      authenticator app to your login, plus one-time backup codes — the
      biggest single reduction in account-takeover risk on a public URL.
- [ ] **Add a passkey** (Account settings → Passkeys) for day-to-day sign-in:
      one Touch ID / Face ID / security-key tap covers both factors, is
      phishing-resistant by construction, and can't be forgotten. Keep the
      password (+ 2FA) as the fallback it becomes.
- [ ] **Keep the app reachable only through your proxy/tunnel.** The default
      compose file binds to `127.0.0.1`, so nothing is exposed directly even
      if the host firewall is open. Don't remove that prefix unless a
      containerized proxy needs it.
- [ ] **Back up off the machine.** The database backs itself up daily and you
      can download a snapshot from the admin dashboard, but photo originals
      need a filesystem backup of `./data` (see the README's backup section).
- [ ] **Update occasionally** — re-run the install one-liner; it pulls the
      latest image and never touches your data.

What's already handled for you: a **first-run setup code** (shown by the
installer and in the server logs) that stops anyone from claiming the admin
account before you do — essential when the app is live on a public URL before
you've finished setup; Argon2id password hashing; per-IP and cross-IP rate
limiting with durable lockouts (behind a Cloudflare Tunnel the per-IP limit
keys on Cloudflare's forge-proof real-client IP; on a directly-exposed instance
it keys on the unspoofable socket address, and behind another reverse proxy the
cross-IP admin and per-gallery caps — which no header can bypass — are the
backstop, so strip inbound `CF-Connecting-IP` at that proxy to keep the per-IP
limit exact); anti-enumeration on
gallery links and logins; per-request access checks on every photo byte;
signed gallery cookies invalidated instantly on password change; a
Content-Security-Policy plus the standard security headers; a concurrency cap
on zip downloads so they can't be used to exhaust the server; the container
runs as an **unprivileged user**, not root; `noindex` on all pages; and no
third-party requests of any kind — fonts and assets are self-hosted, so client
galleries phone home to nobody.

### First-run on a public URL

If you're exposing Lumina publicly *before* creating your account (e.g. the
Cloudflare Tunnel is already live), the setup code is what protects that
window. Get it any time with:

```bash
docker compose logs app | grep "SETUP CODE"
```

Enter it on the setup screen along with your email and password. The code stops
working the moment your account is created.
