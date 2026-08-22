import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { getPublicBaseUrl } from "./settings.ts";

/**
 * WebAuthn ceremony state. A ceremony is two requests ~seconds apart (issue
 * options, verify the authenticator's response), so the pending challenge lives
 * in process memory — same single-process reasoning as the photo worker: no
 * Redis, no extra table. A restart mid-ceremony just means clicking the button
 * again. Challenges are single-use (deleted on lookup) so a captured
 * authenticator response can't be replayed to mint a second session.
 */

interface PendingChallenge {
  challenge: string; // base64url, as issued inside the options
  type: "registration" | "authentication";
  /** Registration only: the admin the new credential must attach to. */
  adminId?: string;
  /** Locked in when the options were issued, so the verify step checks against
   * the same values even if the caller's headers change between requests. */
  rpID: string;
  origin: string;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 60_000; // matches the browser ceremony default timeout

// Memory backstop: the authentication options route is unauthenticated (that's
// inherent — it starts a login), so cap how many pending ceremonies can exist.
// 64 is far beyond any legitimate concurrent use of a single-admin app. The cap
// is counted PER CEREMONY TYPE so an anonymous flood of login-options requests
// can only ever exhaust its own bucket — the signed-in admin's registration
// ceremonies keep working, and the worst an attacker achieves is degrading
// passkey login to the password form for the TTL window. This is a memory
// bound, not a security control.
const MAX_PENDING_PER_TYPE = 64;

const pending = new Map<string, PendingChallenge>();

function sweepExpired(now: number): void {
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
}

/** Returns an opaque handle the client echoes back with the authenticator's
 * response, or null when the pending-ceremony cap is hit. */
export function storeChallenge(entry: Omit<PendingChallenge, "expiresAt">): string | null {
  const now = Date.now();
  sweepExpired(now);
  let sameType = 0;
  for (const existing of pending.values()) {
    if (existing.type === entry.type) sameType += 1;
  }
  if (sameType >= MAX_PENDING_PER_TYPE) return null;
  const id = randomBytes(16).toString("base64url");
  pending.set(id, { ...entry, expiresAt: now + CHALLENGE_TTL_MS });
  return id;
}

/** Single-use lookup: the entry is removed whether or not verification later
 * succeeds, so one issued challenge can never validate two responses. */
export function consumeChallenge(
  id: string | undefined,
  type: PendingChallenge["type"],
): PendingChallenge | null {
  if (!id) return null;
  const entry = pending.get(id);
  if (!entry) return null;
  pending.delete(id);
  if (entry.type !== type || entry.expiresAt <= Date.now()) return null;
  return entry;
}

export interface RelyingParty {
  rpID: string; // the domain credentials are scoped to
  origin: string; // full origin the browser must report in clientDataJSON
}

/**
 * The relying-party identity for a ceremony, derived from where the browser is
 * actually talking to us — the configured public origin when the request comes
 * through it, otherwise the request's own origin (localhost dev, Tailscale,
 * pre-domain setups). Deriving from the request is safe here: a credential is
 * scoped to its RP ID by the BROWSER, and every response is signature-checked
 * against the stored public key — a different origin can't forge either, it
 * would only scope its (useless) ceremony to itself. The verify step re-checks
 * against the values locked in with the challenge, not a fresh derivation.
 */
export async function resolveRelyingParty(request: FastifyRequest): Promise<RelyingParty | null> {
  const candidates: (string | undefined)[] = [
    typeof request.headers.origin === "string" ? request.headers.origin : undefined,
    // Fallback for user agents that omit Origin: reconstruct from Host. Behind
    // the documented proxies the request reached us over HTTPS.
    request.headers.host ? `${request.protocol}://${request.headers.host}` : undefined,
    await getPublicBaseUrl(),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (!url.hostname) continue;
    return { rpID: url.hostname, origin: url.origin };
  }
  return null;
}
