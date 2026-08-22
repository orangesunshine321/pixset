import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamp = (name: string) =>
  integer(name, { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date());

/** Singleton-in-practice: the app only ever lets one row exist (see /setup route). */
export const adminUsers = sqliteTable("admin_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  // TOTP 2FA. The secret is stored while enrolling; totpEnabledAt is set only
  // once a first code is verified — its presence means 2FA is active on login.
  totpSecret: text("totp_secret"),
  totpEnabledAt: integer("totp_enabled_at", { mode: "timestamp_ms" }),
  // Highest TOTP timestep already consumed on a login. A code is only valid if
  // its step is strictly greater, so a captured code can't be replayed within
  // its ~90s validity window to mint a second session.
  totpLastUsedStep: integer("totp_last_used_step"),
  // JSON array of { hash, usedAt } — single-use recovery codes (sha256-hashed,
  // safe because they're high-entropy random, not user-chosen).
  totpBackupCodes: text("totp_backup_codes"),
  // Optional outgoing webhook (Discord/Slack/ntfy/…) pinged when a client
  // submits their selection. Stored on the singleton admin row.
  notifyWebhookUrl: text("notify_webhook_url"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

/** WebAuthn passkeys — an alternative way to sign in to the SAME admin account
 * (Touch ID / Face ID / security key), not a second account system. A passkey
 * login satisfies both factors in one gesture (possession + biometric/PIN, user
 * verification is required end-to-end), so it never additionally prompts for a
 * TOTP code. The password always remains as a fallback. */
export const adminPasskeys = sqliteTable(
  "admin_passkeys",
  {
    // The authenticator's credential ID (base64url) — globally unique by
    // construction, and exactly what an authentication response is keyed by.
    id: text("id").primaryKey(),
    adminId: text("admin_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // operator-chosen label, e.g. "MacBook Touch ID"
    publicKey: text("public_key").notNull(), // COSE public key, base64url
    // Signature counter some authenticators increment per use (many passkey
    // providers always report 0). Persisted so clone detection can fire.
    counter: integer("counter").notNull().default(0),
    transports: text("transports"), // JSON array hint for the browser, e.g. ["internal"]
    backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false), // synced to a cloud keychain?
    createdAt: timestamp("created_at"),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("admin_passkeys_admin_id_idx").on(table.adminId)],
);

/** DB-backed (not stateless): admin traffic is low-volume, so real per-device revocation is cheap. */
export const adminSessions = sqliteTable(
  "admin_sessions",
  {
    id: text("id").primaryKey(), // sha256 hex of the opaque session token; raw token only ever lives in the cookie
    adminId: text("admin_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    userAgent: text("user_agent"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: timestamp("created_at"),
    lastSeenAt: timestamp("last_seen_at"),
  },
  (table) => [index("admin_sessions_admin_id_idx").on(table.adminId)],
);

export const galleries = sqliteTable(
  "galleries",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(), // nanoid(21), ~125 bits entropy — the only externally-facing identifier
    title: text("title").notNull(),
    passwordHash: text("password_hash"), // null = no password
    // Bumped on every password set/change/removal: instantly invalidates all
    // previously issued gallery-access cookies without a server-side session store.
    passwordVersion: integer("password_version").notNull().default(0),
    coverPhotoId: text("cover_photo_id").references((): any => photos.id, { onDelete: "set null" }),
    photoCount: integer("photo_count").notNull().default(0),
    // When true, clients can download originals (per-photo and as zips) —
    // off by default so sharing a link never hands out full-res files
    // unless the photographer opts in.
    allowDownloads: integer("allow_downloads", { mode: "boolean" }).notNull().default(false),
    // Archived galleries are hidden from the default admin list but remain
    // fully accessible by their link — a way to declutter finished shoots.
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    // Optional link lifetime: once past, the public link stops working (admins
    // still have full access). Null = never expires.
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    // Set when the client submits their picks as final; cleared when the
    // photographer marks the gallery reviewed. The "needs attention" signal.
    selectionSubmittedAt: integer("selection_submitted_at", { mode: "timestamp_ms" }),
    // Optional message the client left with their submission; persists for
    // reference even after the submission is marked reviewed.
    selectionNote: text("selection_note"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [uniqueIndex("galleries_slug_idx").on(table.slug)],
);

/** Named groupings of a gallery's photos (e.g. "Raws" vs "Final edits"). Opt-in:
 * a gallery with no sets behaves exactly as before (all photos ungrouped, i.e.
 * photos.setId IS NULL, governed by the gallery-level allowDownloads). The two
 * client-facing toggles are independent: a set can be visible-but-not-downloadable
 * (proofing) or hidden entirely (admin-only work-in-progress). */
export const photoSets = sqliteTable(
  "photo_sets",
  {
    id: text("id").primaryKey(),
    galleryId: text("gallery_id")
      .notNull()
      .references(() => galleries.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    sortIndex: integer("sort_index").notNull().default(0), // order of sets within the gallery
    // Whether the client sees this set's photos at all. Hidden = admin-only.
    visibleToClient: integer("visible_to_client", { mode: "boolean" }).notNull().default(true),
    // Whether the client may download this set's originals. Only meaningful when
    // visible (you can't download what you can't see).
    allowDownloads: integer("allow_downloads", { mode: "boolean" }).notNull().default(false),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("photo_sets_gallery_id_idx").on(table.galleryId),
    index("photo_sets_gallery_sort_idx").on(table.galleryId, table.sortIndex),
  ],
);

export const photos = sqliteTable(
  "photos",
  {
    id: text("id").primaryKey(), // nanoid, never sequential — prevents enumeration
    galleryId: text("gallery_id")
      .notNull()
      .references(() => galleries.id, { onDelete: "cascade" }),
    // Optional grouping into a set. NULL = ungrouped (the default / legacy state).
    // SET NULL on delete: removing a set orphans its photos back to ungrouped,
    // it never deletes them.
    setId: text("set_id").references(() => photoSets.id, { onDelete: "set null" }),
    originalFilename: text("original_filename").notNull(), // exactly as uploaded, incl. extension
    // Extension stripped, precomputed at ingest: this is exactly what the
    // Lightroom copy-list exports, so there's zero string work at read time.
    baseFilename: text("base_filename").notNull(),
    fileExt: text("file_ext").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width"),
    height: integer("height"),
    checksumSha256: text("checksum_sha256").notNull(), // integrity + dedupe-on-reupload
    thumbhash: text("thumbhash"), // base64 placeholder, inlined in grid JSON, zero extra requests
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }), // EXIF DateTimeOriginal, sort fallback
    sortIndex: integer("sort_index").notNull().default(0),
    // This column IS the background job queue — no separate jobs table needed at this scale.
    status: text("status", { enum: ["pending", "processing", "ready", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("photos_gallery_id_idx").on(table.galleryId),
    index("photos_gallery_status_idx").on(table.galleryId, table.status),
    index("photos_gallery_sort_idx").on(table.galleryId, table.sortIndex),
    index("photos_set_idx").on(table.setId),
    uniqueIndex("photos_gallery_checksum_idx").on(table.galleryId, table.checksumSha256),
  ],
);

export const favorites = sqliteTable(
  "favorites",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    galleryId: text("gallery_id")
      .notNull()
      .references(() => galleries.id, { onDelete: "cascade" }),
    photoId: text("photo_id")
      .notNull()
      .references(() => photos.id, { onDelete: "cascade" }),
    // Provenance only — NOT a partition key. Favorites are a single shared set per
    // gallery (see UNIQUE below): the product needs one consolidated pick list to
    // paste into Lightroom, not per-device lists that "lose" picks across visits.
    toggledByClientToken: text("toggled_by_client_token").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("favorites_gallery_photo_idx").on(table.galleryId, table.photoId),
    index("favorites_gallery_id_idx").on(table.galleryId),
  ],
);

/** Durable, restart-proof brute-force tracking — no Redis, no in-memory counters. */
export const authAttempts = sqliteTable(
  "auth_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    scope: text("scope", { enum: ["admin_login", "gallery_unlock"] }).notNull(),
    galleryId: text("gallery_id"),
    ipHash: text("ip_hash").notNull(), // sha256 of the client IP, never raw
    success: integer("success", { mode: "boolean" }).notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("auth_attempts_scope_ip_idx").on(table.scope, table.ipHash, table.createdAt),
    index("auth_attempts_scope_gallery_idx").on(table.scope, table.galleryId, table.createdAt),
  ],
);

/** Operator-tunable app settings, editable from the admin panel. A tiny
 * key→value store (values are JSON-encoded); anything absent falls back to its
 * env/config default, so an empty table behaves exactly like today. */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON-encoded
  updatedAt: timestamp("updated_at"),
});
