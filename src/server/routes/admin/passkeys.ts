import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { db, schema } from "../../db/client.ts";
import { ADMIN_SESSION_COOKIE, createAdminSession, verifyPassword } from "../../services/auth.ts";
import { consumeChallenge, resolveRelyingParty, storeChallenge } from "../../services/passkeys.ts";
import { checkRateLimit, recordAttempt } from "../../services/rateLimiter.ts";
import { getClientIp } from "../../lib/http.ts";
import { requireAdmin } from "../../middleware/requireAdmin.ts";
import { config } from "../../config.ts";

const RP_NAME = "Lumina";

/** Sign in with a passkey — the same admin account, without the password. User
 * verification is required end-to-end (Touch ID / Face ID / PIN), so one
 * gesture covers both factors and the TOTP step never applies here. */
export async function passkeyLoginRoutes(app: FastifyInstance) {
  app.post("/api/admin/login/passkey/options", async (request, reply) => {
    // Same gate as password login: a locked-out IP doesn't get to start
    // ceremonies either. Issuing options is not itself an "attempt".
    const ip = getClientIp(request);
    const rateLimit = await checkRateLimit({ scope: "admin_login", ip });
    if (!rateLimit.allowed) {
      reply.header("Retry-After", String(rateLimit.retryAfterSeconds));
      return reply.code(429).send({ error: "too_many_attempts", retryAfterSeconds: rateLimit.retryAfterSeconds });
    }

    const rp = await resolveRelyingParty(request);
    if (!rp) return reply.code(400).send({ error: "invalid_request" });

    // Empty allowCredentials: passkeys are registered as discoverable, so the
    // browser finds them by RP ID alone. This also means the response leaks
    // nothing — no credential IDs, no hint whether any passkey exists.
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: "required",
    });

    const challengeId = storeChallenge({
      challenge: options.challenge,
      type: "authentication",
      rpID: rp.rpID,
      origin: rp.origin,
    });
    if (!challengeId) {
      reply.header("Retry-After", "60");
      return reply.code(429).send({ error: "too_many_attempts", retryAfterSeconds: 60 });
    }

    return { challengeId, options };
  });

  app.post<{ Body: { challengeId: string; response: AuthenticationResponseJSON } }>(
    "/api/admin/login/passkey",
    {
      schema: {
        body: {
          type: "object",
          required: ["challengeId", "response"],
          properties: {
            challengeId: { type: "string", maxLength: 64 },
            response: { type: "object" }, // deep shape is validated by the WebAuthn library
          },
        },
      },
    },
    async (request, reply) => {
      const ip = getClientIp(request);
      const rateLimit = await checkRateLimit({ scope: "admin_login", ip });
      if (!rateLimit.allowed) {
        reply.header("Retry-After", String(rateLimit.retryAfterSeconds));
        return reply.code(429).send({ error: "too_many_attempts", retryAfterSeconds: rateLimit.retryAfterSeconds });
      }

      // One response body for every failure below — like password login, the
      // caller can't distinguish "unknown credential" from "bad signature".
      const fail = async () => {
        await recordAttempt({ scope: "admin_login", ip, success: false });
        return reply.code(401).send({ error: "invalid_credentials" });
      };

      const pending = consumeChallenge(request.body.challengeId, "authentication");
      if (!pending) return fail();

      // The body schema only checks `response` is an object — pin down the one
      // field WE use before it reaches a query; the library validates the rest.
      const credentialId = request.body.response?.id;
      if (typeof credentialId !== "string" || credentialId.length === 0) return fail();

      // Joined against admin_users like verifyAdminSession: a passkey row can
      // never authenticate past its account (the sqlite3-CLI recovery path
      // deletes the admin row with foreign keys OFF, skipping the cascade).
      const [row] = await db
        .select({ passkey: schema.adminPasskeys, admin: schema.adminUsers })
        .from(schema.adminPasskeys)
        .innerJoin(schema.adminUsers, eq(schema.adminUsers.id, schema.adminPasskeys.adminId))
        .where(eq(schema.adminPasskeys.id, credentialId))
        .limit(1);
      if (!row) return fail();

      let verified = false;
      let newCounter = row.passkey.counter;
      try {
        const result = await verifyAuthenticationResponse({
          response: request.body.response,
          expectedChallenge: pending.challenge,
          expectedOrigin: pending.origin,
          expectedRPID: pending.rpID,
          credential: {
            id: row.passkey.id,
            publicKey: new Uint8Array(Buffer.from(row.passkey.publicKey, "base64url")),
            counter: row.passkey.counter,
            transports: parseTransports(row.passkey.transports),
          },
          requireUserVerification: true,
        });
        verified = result.verified;
        newCounter = result.authenticationInfo.newCounter;
      } catch {
        // Malformed response, wrong origin/RP, bad signature, counter
        // regression — all just a failed login.
        return fail();
      }
      if (!verified) return fail();

      await db
        .update(schema.adminPasskeys)
        .set({ counter: newCounter, lastUsedAt: new Date() })
        .where(eq(schema.adminPasskeys.id, row.passkey.id));

      await recordAttempt({ scope: "admin_login", ip, success: true });

      const { rawToken, expiresAt } = await createAdminSession(row.admin.id, request.headers["user-agent"]);
      reply.setCookie(ADMIN_SESSION_COOKIE, rawToken, {
        httpOnly: true,
        secure: config.isProduction,
        sameSite: "strict",
        path: "/",
        expires: expiresAt,
      });

      return { ok: true, email: row.admin.email };
    },
  );
}

/** Passkey management, from Account settings. Mirrors the 2FA pattern: starting
 * enrollment needs only a signed-in session, but the steps that change what can
 * sign in (adding, removing) also require the password. */
export async function passkeyManageRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAdmin);

  app.get("/api/admin/account/passkeys", async (request) => {
    const rows = await db
      .select()
      .from(schema.adminPasskeys)
      .where(eq(schema.adminPasskeys.adminId, request.adminSession!.adminId))
      .orderBy(schema.adminPasskeys.createdAt);
    return {
      passkeys: rows.map((row) => ({
        id: row.id,
        name: row.name,
        backedUp: row.backedUp,
        createdAt: row.createdAt.getTime(),
        lastUsedAt: row.lastUsedAt?.getTime() ?? null,
      })),
    };
  });

  app.post("/api/admin/account/passkeys/options", async (request, reply) => {
    const admin = await currentAdmin(request.adminSession!.adminId);
    if (!admin) return reply.code(401).send({ error: "unauthorized" });

    const rp = await resolveRelyingParty(request);
    if (!rp) return reply.code(400).send({ error: "invalid_request" });

    const existing = await db
      .select({ id: schema.adminPasskeys.id, transports: schema.adminPasskeys.transports })
      .from(schema.adminPasskeys)
      .where(eq(schema.adminPasskeys.adminId, admin.id));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp.rpID,
      userName: admin.email,
      userID: new TextEncoder().encode(admin.id),
      attestationType: "none",
      // The browser refuses to re-register an authenticator that's already
      // enrolled instead of silently creating a duplicate.
      excludeCredentials: existing.map((row) => ({
        id: row.id,
        transports: parseTransports(row.transports),
      })),
      // Discoverable + user-verified: lets login be a single gesture with no
      // email typed and no TOTP prompt, and lets the login options endpoint
      // reveal nothing. Every passkey-capable platform supports both.
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });

    const challengeId = storeChallenge({
      challenge: options.challenge,
      type: "registration",
      adminId: admin.id,
      rpID: rp.rpID,
      origin: rp.origin,
    });
    if (!challengeId) {
      reply.header("Retry-After", "60");
      return reply.code(429).send({ error: "too_many_attempts", retryAfterSeconds: 60 });
    }

    return { challengeId, options };
  });

  app.post<{ Body: { challengeId: string; password: string; name?: string; response: RegistrationResponseJSON } }>(
    "/api/admin/account/passkeys",
    {
      schema: {
        body: {
          type: "object",
          required: ["challengeId", "password", "response"],
          properties: {
            challengeId: { type: "string", maxLength: 64 },
            password: { type: "string", maxLength: 512 },
            name: { type: "string", maxLength: 64 },
            response: { type: "object" },
          },
        },
      },
    },
    async (request, reply) => {
      const admin = await currentAdmin(request.adminSession!.adminId);
      if (!admin) return reply.code(401).send({ error: "unauthorized" });

      if (!(await verifyPassword(admin.passwordHash, request.body.password))) {
        return reply.code(403).send({ error: "wrong_password" });
      }

      const pending = consumeChallenge(request.body.challengeId, "registration");
      if (!pending || pending.adminId !== admin.id) {
        return reply.code(400).send({ error: "invalid_challenge" });
      }

      let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try {
        verification = await verifyRegistrationResponse({
          response: request.body.response,
          expectedChallenge: pending.challenge,
          expectedOrigin: pending.origin,
          expectedRPID: pending.rpID,
          requireUserVerification: true,
        });
      } catch {
        return reply.code(400).send({ error: "verification_failed" });
      }
      if (!verification.verified) return reply.code(400).send({ error: "verification_failed" });

      const { credential, credentialBackedUp } = verification.registrationInfo;
      const name = request.body.name?.trim().slice(0, 64) || "Passkey";
      try {
        await db.insert(schema.adminPasskeys).values({
          id: credential.id,
          adminId: admin.id,
          name,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          counter: credential.counter,
          transports: JSON.stringify(credential.transports ?? []),
          backedUp: credentialBackedUp,
        });
      } catch (err) {
        // Credential IDs are globally unique — a constraint conflict means this
        // exact authenticator is already enrolled. Anything else (disk full,
        // locked DB) propagates to the 500 handler like every other route.
        if (isUniqueConstraintError(err)) {
          return reply.code(409).send({ error: "already_registered" });
        }
        throw err;
      }

      return reply.code(201).send({ ok: true, id: credential.id, name });
    },
  );

  /** Removing a login method is password-gated for the same reason disabling
   * 2FA is: an unattended unlocked session shouldn't be able to do it. */
  app.delete<{ Params: { id: string }; Body: { password: string } }>(
    "/api/admin/account/passkeys/:id",
    {
      schema: {
        body: {
          type: "object",
          required: ["password"],
          properties: { password: { type: "string", maxLength: 512 } },
        },
      },
    },
    async (request, reply) => {
      const admin = await currentAdmin(request.adminSession!.adminId);
      if (!admin) return reply.code(401).send({ error: "unauthorized" });

      if (!(await verifyPassword(admin.passwordHash, request.body.password))) {
        return reply.code(403).send({ error: "wrong_password" });
      }

      const result = await db
        .delete(schema.adminPasskeys)
        .where(
          and(
            eq(schema.adminPasskeys.id, request.params.id),
            eq(schema.adminPasskeys.adminId, admin.id),
          ),
        )
        .returning({ id: schema.adminPasskeys.id });
      if (result.length === 0) return reply.code(404).send({ error: "not_found" });

      return { ok: true };
    },
  );
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as { code?: string }).code === "string" &&
    (err as { code: string }).code.startsWith("SQLITE_CONSTRAINT")
  );
}

function parseTransports(stored: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!stored) return undefined;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function currentAdmin(adminId: string) {
  const [admin] = await db
    .select()
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.id, adminId))
    .limit(1);
  return admin ?? null;
}
