import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import * as OTPAuth from "otpauth";
import { eq } from "drizzle-orm";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import {
  ADMIN_COOKIE,
  ADMIN_PASSWORD,
  cleanupDataDir,
  cookieValue,
  createApp,
  db,
  schema,
  setupAdmin,
  sqlite,
  type App,
} from "./helpers.ts";

let app: App;
let adminCookie: string;

beforeAll(async () => {
  app = await createApp();
  ({ adminCookie } = await setupAdmin(app));
});

afterAll(async () => {
  await app.close();
  sqlite.close();
  cleanupDataDir();
});

// app.inject requests carry no Origin header, so the server derives the relying
// party from Host — inject defaults to "localhost:80", which URL-normalizes to
// the bare origin below (80 is http's default port).
const ORIGIN = "http://localhost";
const RP_ID = "localhost";

/** A minimal software authenticator: real P-256 keys, real CBOR attestation,
 * real DER signatures — the server verifies everything with no mocks. */
class SoftAuthenticator {
  credentialId = randomBytes(32);
  keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  counter = 0;
  rpId: string;
  origin: string;

  constructor(opts: { rpId?: string; origin?: string } = {}) {
    this.rpId = opts.rpId ?? RP_ID;
    this.origin = opts.origin ?? ORIGIN;
  }

  get id(): string {
    return this.credentialId.toString("base64url");
  }

  private cosePublicKey(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    // COSE_Key (EC2): 1=kty(2, EC2), 3=alg(-7, ES256), -1=crv(1, P-256), -2=x, -3=y
    return isoCBOR.encode(
      new Map<number, import("@levischuck/tiny-cbor").CBORType>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
        [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
      ]),
    );
  }

  /** WebAuthn registration response for the given challenge ("none" attestation). */
  register(challenge: string, opts: { uv?: boolean } = {}) {
    const rpIdHash = createHash("sha256").update(this.rpId).digest();
    // UP | AT, plus UV unless a test is modeling a silent-tap authenticator.
    const flags = Buffer.from([0x41 | ((opts.uv ?? true) ? 0x04 : 0)]);
    const signCount = Buffer.alloc(4);
    const aaguid = Buffer.alloc(16);
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      rpIdHash,
      flags,
      signCount,
      aaguid,
      credIdLen,
      this.credentialId,
      Buffer.from(this.cosePublicKey()),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, import("@levischuck/tiny-cbor").CBORType>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(authData)],
      ]),
    );
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge, origin: this.origin, crossOrigin: false }),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        attestationObject: Buffer.from(attestationObject).toString("base64url"),
        transports: ["internal"],
      },
    };
  }

  /** WebAuthn authentication (assertion) response for the given challenge.
   * `counter` overrides the reported signCount — pass 0 repeatedly to model
   * synced passkeys (Apple/Google report 0 forever), or an explicit value to
   * exercise clone detection. */
  authenticate(challenge: string, opts: { signWith?: KeyObject; uv?: boolean; counter?: number } = {}) {
    this.counter = opts.counter ?? this.counter + 1;
    const rpIdHash = createHash("sha256").update(this.rpId).digest();
    const flags = Buffer.from([0x01 | ((opts.uv ?? true) ? 0x04 : 0)]); // UP (+ UV)
    const signCount = Buffer.alloc(4);
    signCount.writeUInt32BE(this.counter);
    const authenticatorData = Buffer.concat([rpIdHash, flags, signCount]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge, origin: this.origin, crossOrigin: false }),
    );
    const clientDataHash = createHash("sha256").update(clientDataJSON).digest();
    const signature = createSign("SHA256")
      .update(Buffer.concat([authenticatorData, clientDataHash]))
      .sign(opts.signWith ?? this.keys.privateKey); // DER-encoded, as WebAuthn requires
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString("base64url"),
        authenticatorData: authenticatorData.toString("base64url"),
        signature: signature.toString("base64url"),
        userHandle: null,
      },
    };
  }
}

async function registrationOptions() {
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/account/passkeys/options",
    cookies: { [ADMIN_COOKIE]: adminCookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { challengeId: string; options: { challenge: string; rp: { id: string } } };
}

async function registerPasskey(authenticator: SoftAuthenticator, name = "Test key") {
  const { challengeId, options } = await registrationOptions();
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/account/passkeys",
    payload: {
      challengeId,
      password: ADMIN_PASSWORD,
      name,
      response: authenticator.register(options.challenge),
    },
    cookies: { [ADMIN_COOKIE]: adminCookie },
  });
  return res;
}

async function loginOptions() {
  const res = await app.inject({ method: "POST", url: "/api/admin/login/passkey/options" });
  return res;
}

async function loginWithPasskey(authenticator: SoftAuthenticator) {
  const optionsRes = await loginOptions();
  expect(optionsRes.statusCode).toBe(200);
  const { challengeId, options } = optionsRes.json();
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/login/passkey",
    payload: { challengeId, response: authenticator.authenticate(options.challenge) },
  });
  return res;
}

/** Failed-attempt rows accumulate per test; wipe them after every test so one
 * test's failures never rate-limit the next — even when a test fails midway. */
afterEach(() => {
  sqlite.prepare("DELETE FROM auth_attempts").run();
  vi.useRealTimers();
});

describe("passkey registration", () => {
  it("issues discoverable, user-verified registration options", async () => {
    const { challengeId, options } = await registrationOptions();
    expect(challengeId).toBeTruthy();
    expect(options.rp.id).toBe(RP_ID);
    expect((options as any).authenticatorSelection).toMatchObject({
      residentKey: "required",
      userVerification: "required",
    });
  });

  it("requires the password to add a passkey", async () => {
    const authenticator = new SoftAuthenticator();
    const { challengeId, options } = await registrationOptions();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/account/passkeys",
      payload: {
        challengeId,
        password: "not-the-password",
        response: authenticator.register(options.challenge),
      },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("wrong_password");
  });

  it("registers, lists, and rejects a duplicate of the same credential", async () => {
    const authenticator = new SoftAuthenticator();
    const created = await registerPasskey(authenticator, "MacBook Touch ID");
    expect(created.statusCode).toBe(201);
    expect(created.json().name).toBe("MacBook Touch ID");

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/account/passkeys",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    const names = list.json().passkeys.map((p: { name: string }) => p.name);
    expect(names).toContain("MacBook Touch ID");

    const duplicate = await registerPasskey(authenticator, "Same key again");
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe("already_registered");
  });

  it("rejects a response that doesn't match the issued challenge", async () => {
    const authenticator = new SoftAuthenticator();
    const { challengeId } = await registrationOptions();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/account/passkeys",
      payload: {
        challengeId,
        password: ADMIN_PASSWORD,
        response: authenticator.register("some-other-challenge"),
      },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("verification_failed");
  });

  it("defaults an omitted or blank name to \"Passkey\"", async () => {
    for (const name of [undefined, "   "]) {
      const authenticator = new SoftAuthenticator();
      const { challengeId, options } = await registrationOptions();
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/account/passkeys",
        payload: {
          challengeId,
          password: ADMIN_PASSWORD,
          ...(name === undefined ? {} : { name }),
          response: authenticator.register(options.challenge),
        },
        cookies: { [ADMIN_COOKIE]: adminCookie },
      });
      expect(res.statusCode, `name=${JSON.stringify(name)}`).toBe(201);
      expect(res.json().name).toBe("Passkey");
    }
  });

  it("requires an admin session for every management route", async () => {
    // Bodies must pass schema validation — it runs before the auth preHandler.
    const attempts = [
      { method: "POST", url: "/api/admin/account/passkeys/options", payload: undefined },
      {
        method: "POST",
        url: "/api/admin/account/passkeys",
        payload: { challengeId: "x", password: "x", response: {} },
      },
      { method: "GET", url: "/api/admin/account/passkeys", payload: undefined },
      { method: "DELETE", url: "/api/admin/account/passkeys/some-id", payload: { password: "x" } },
    ] as const;
    for (const { method, url, payload } of attempts) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe("passkey login", () => {
  it("signs in with a registered passkey and mints a working admin session", async () => {
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(authenticator, "Login key")).statusCode).toBe(201);

    const res = await loginWithPasskey(authenticator);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    const sessionCookie = cookieValue(res, ADMIN_COOKIE);
    expect(sessionCookie).toBeTruthy();

    const me = await app.inject({
      method: "GET",
      url: "/api/admin/me",
      cookies: { [ADMIN_COOKIE]: sessionCookie! },
    });
    expect(me.statusCode).toBe(200);

    // Counter and last-used tracking persisted.
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/account/passkeys",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    const entry = list.json().passkeys.find((p: { id: string }) => p.id === authenticator.id);
    expect(entry.lastUsedAt).not.toBeNull();
  });

  it("never prompts for a TOTP code — user verification already covers both factors", async () => {
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(authenticator, "2fa bypass check")).statusCode).toBe(201);

    // Enable TOTP 2FA the same way twofactor.test.ts does.
    const setup = await app.inject({
      method: "POST",
      url: "/api/admin/account/2fa/setup",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    const secret: string = setup.json().secret;
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 });
    const enable = await app.inject({
      method: "POST",
      url: "/api/admin/account/2fa/enable",
      payload: { password: ADMIN_PASSWORD, code: totp.generate() },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(enable.statusCode).toBe(200);

    // Password login now demands a code…
    const passwordLogin = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      payload: { email: "admin@test.dev", password: ADMIN_PASSWORD },
    });
    expect(passwordLogin.statusCode).toBe(401);
    expect(passwordLogin.json().error).toBe("totp_required");

    // …but a passkey signs straight in.
    const res = await loginWithPasskey(authenticator);
    expect(res.statusCode).toBe(200);
  });

  it("rejects an unknown credential with the same response as any bad login", async () => {
    const stranger = new SoftAuthenticator(); // never registered
    const res = await loginWithPasskey(stranger);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_credentials");
  });

  it("rejects a signature from the wrong key", async () => {
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(authenticator, "Tamper target")).statusCode).toBe(201);

    const { privateKey: wrongKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const optionsRes = await loginOptions();
    const { challengeId, options } = optionsRes.json();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/login/passkey",
      payload: {
        challengeId,
        response: authenticator.authenticate(options.challenge, { signWith: wrongKey }),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_credentials");
  });

  it("refuses to validate the same challenge twice", async () => {
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(authenticator, "Replay target")).statusCode).toBe(201);

    const optionsRes = await loginOptions();
    const { challengeId, options } = optionsRes.json();

    const first = await app.inject({
      method: "POST",
      url: "/api/admin/login/passkey",
      payload: { challengeId, response: authenticator.authenticate(options.challenge) },
    });
    expect(first.statusCode).toBe(200);

    // A FRESH, otherwise-valid assertion for the same challengeId: its counter
    // is higher than the stored one, so the signature-counter guard can't be
    // what rejects it — only challenge single-use can.
    const replay = await app.inject({
      method: "POST",
      url: "/api/admin/login/passkey",
      payload: { challengeId, response: authenticator.authenticate(options.challenge) },
    });
    expect(replay.statusCode).toBe(401);
  });

  it("rejects an assertion without user verification — UV is what stands in for the second factor", async () => {
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(authenticator, "UV enforcement")).statusCode).toBe(201);

    const optionsRes = await loginOptions();
    const { challengeId, options } = optionsRes.json();
    expect(options.userVerification).toBe("required");

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/login/passkey",
      payload: { challengeId, response: authenticator.authenticate(options.challenge, { uv: false }) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_credentials");
  });

  it("rejects a registration without user verification", async () => {
    const authenticator = new SoftAuthenticator();
    const { challengeId, options } = await registrationOptions();
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/account/passkeys",
      payload: {
        challengeId,
        password: ADMIN_PASSWORD,
        response: authenticator.register(options.challenge, { uv: false }),
      },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("verification_failed");
  });

  it("login options are usernameless and reveal nothing about registered passkeys", async () => {
    const optionsRes = await loginOptions();
    expect(optionsRes.statusCode).toBe(200);
    const { options } = optionsRes.json();
    // Empty/absent allowCredentials: no credential IDs, no hint any passkey
    // exists. Populating it from the DB would leak both to anonymous callers.
    expect(options.allowCredentials ?? []).toEqual([]);
  });

  it("accepts always-zero-counter passkeys (Apple/Google synced credentials) on every login", async () => {
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(authenticator, "Synced passkey")).statusCode).toBe(201);

    for (let i = 0; i < 2; i++) {
      const optionsRes = await loginOptions();
      const { challengeId, options } = optionsRes.json();
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/login/passkey",
        payload: { challengeId, response: authenticator.authenticate(options.challenge, { counter: 0 }) },
      });
      expect(res.statusCode, `zero-counter login #${i + 1}`).toBe(200);
    }
  });

  it("persists the signature counter and rejects a cloned authenticator that regresses it", async () => {
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(authenticator, "Clone detection")).statusCode).toBe(201);

    const first = await loginOptions();
    const firstBody = first.json();
    const ok = await app.inject({
      method: "POST",
      url: "/api/admin/login/passkey",
      payload: {
        challengeId: firstBody.challengeId,
        response: authenticator.authenticate(firstBody.options.challenge, { counter: 5 }),
      },
    });
    expect(ok.statusCode).toBe(200);

    // Persistence proven directly: an unpersisted counter (still 0) would let
    // the regressed value below pass.
    const [row] = await db
      .select({ counter: schema.adminPasskeys.counter })
      .from(schema.adminPasskeys)
      .where(eq(schema.adminPasskeys.id, authenticator.id));
    expect(row!.counter).toBe(5);

    const second = await loginOptions();
    const secondBody = second.json();
    const cloned = await app.inject({
      method: "POST",
      url: "/api/admin/login/passkey",
      payload: {
        challengeId: secondBody.challengeId,
        response: authenticator.authenticate(secondBody.options.challenge, { counter: 3 }),
      },
    });
    expect(cloned.statusCode).toBe(401);
  });

  it("expires unused challenges after their TTL", async () => {
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(authenticator, "TTL target")).statusCode).toBe(201);

    // Login ceremony: options now, response 61s later.
    const optionsRes = await loginOptions();
    const { challengeId, options } = optionsRes.json();
    const response = authenticator.authenticate(options.challenge);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    const late = await app.inject({
      method: "POST",
      url: "/api/admin/login/passkey",
      payload: { challengeId, response },
    });
    expect(late.statusCode).toBe(401);
    vi.useRealTimers();

    // Registration ceremony: same 61s staleness → invalid_challenge.
    const reg = await registrationOptions();
    const regResponse = authenticator.register(reg.options.challenge);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);
    const lateReg = await app.inject({
      method: "POST",
      url: "/api/admin/account/passkeys",
      payload: { challengeId: reg.challengeId, password: ADMIN_PASSWORD, response: regResponse },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(lateReg.statusCode).toBe(400);
    expect(lateReg.json().error).toBe("invalid_challenge");
  });

  it("caps pending login ceremonies per type without blocking admin registration", async () => {
    const { storeChallenge, consumeChallenge } = await import("../services/passkeys.ts");
    // Fill the authentication bucket regardless of leftovers from other tests.
    const filler = { challenge: "x", type: "authentication" as const, rpID: "localhost", origin: ORIGIN };
    const stored: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = storeChallenge(filler);
      if (id === null) break;
      stored.push(id);
    }
    expect(stored.length).toBeLessThan(100); // the cap engaged
    expect(storeChallenge(filler)).toBeNull();

    const blocked = await loginOptions();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");

    // The admin's registration ceremonies use their own bucket.
    const reg = await app.inject({
      method: "POST",
      url: "/api/admin/account/passkeys/options",
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(reg.statusCode).toBe(200);

    // Drain so later tests are unaffected.
    for (const id of stored) consumeChallenge(id, "authentication");
    const after = await loginOptions();
    expect(after.statusCode).toBe(200);
  });

  it("runs the full ceremony against the Origin header the way real browsers do", async () => {
    const authenticator = new SoftAuthenticator({ rpId: "photos.example", origin: "https://photos.example" });
    const originHeader = { origin: "https://photos.example" };

    const regOptions = await app.inject({
      method: "POST",
      url: "/api/admin/account/passkeys/options",
      headers: originHeader,
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(regOptions.statusCode).toBe(200);
    const regBody = regOptions.json();
    // Origin wins over the Host fallback ("localhost") — behind a proxy, Host
    // may be the internal upstream while Origin is the public domain.
    expect(regBody.options.rp.id).toBe("photos.example");

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/account/passkeys",
      payload: {
        challengeId: regBody.challengeId,
        password: ADMIN_PASSWORD,
        name: "Origin-derived key",
        response: authenticator.register(regBody.options.challenge),
      },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(created.statusCode).toBe(201);

    const loginOpts = await app.inject({
      method: "POST",
      url: "/api/admin/login/passkey/options",
      headers: originHeader,
    });
    expect(loginOpts.statusCode).toBe(200);
    const loginBody = loginOpts.json();
    expect(loginBody.options.rpId).toBe("photos.example");

    const login = await app.inject({
      method: "POST",
      url: "/api/admin/login/passkey",
      payload: {
        challengeId: loginBody.challengeId,
        response: authenticator.authenticate(loginBody.options.challenge),
      },
    });
    expect(login.statusCode).toBe(200);
  });

  it("counts failures against the admin-login rate limit", async () => {
    const stranger = new SoftAuthenticator();
    // Per-IP backoff starts after 5 consecutive failures.
    for (let i = 0; i < 5; i++) {
      const res = await loginWithPasskey(stranger);
      expect(res.statusCode).toBe(401);
    }
    const blocked = await loginOptions();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("too_many_attempts");
  });
});

describe("passkey removal and recovery hygiene", () => {
  it("removes a passkey only with the correct password, after which it can't sign in", async () => {
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(authenticator, "Removable")).statusCode).toBe(201);

    const wrongPassword = await app.inject({
      method: "DELETE",
      url: `/api/admin/account/passkeys/${encodeURIComponent(authenticator.id)}`,
      payload: { password: "not-the-password" },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(wrongPassword.statusCode).toBe(403);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/admin/account/passkeys/${encodeURIComponent(authenticator.id)}`,
      payload: { password: ADMIN_PASSWORD },
      cookies: { [ADMIN_COOKIE]: adminCookie },
    });
    expect(removed.statusCode).toBe(200);

    const login = await loginWithPasskey(authenticator);
    expect(login.statusCode).toBe(401);
  });

  it("a passkey orphaned by the sqlite3-CLI account reset cannot authenticate", async () => {
    const authenticator = new SoftAuthenticator();
    expect((await registerPasskey(authenticator, "Orphan")).statusCode).toBe(201);

    // The documented lockout recovery deletes the admin row from the sqlite3
    // CLI, where foreign_keys is OFF — the passkey row survives as an orphan.
    sqlite.pragma("foreign_keys = OFF");
    sqlite.prepare("DELETE FROM admin_sessions").run();
    sqlite.prepare("DELETE FROM admin_users").run();
    sqlite.pragma("foreign_keys = ON");

    const [orphan] = await db.select().from(schema.adminPasskeys);
    expect(orphan).toBeTruthy(); // still on disk…

    const res = await loginWithPasskey(authenticator);
    expect(res.statusCode).toBe(401); // …but useless without its account

    // The wipe emptied admin_users, so the self-disabling setup route works
    // again — restore the account so tests added after this one keep working.
    ({ adminCookie } = await setupAdmin(app));
  });
});
