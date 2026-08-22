import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import Fastify, { type FastifyError } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import fastifyCompress from "@fastify/compress";
import "./types.ts";
import { config } from "./config.ts";
import { setupRoutes } from "./routes/setup.ts";
import { adminAuthRoutes } from "./routes/admin/auth.ts";
import { passkeyLoginRoutes, passkeyManageRoutes } from "./routes/admin/passkeys.ts";
import { photoRoutes } from "./routes/photos.ts";
import { galleryAdminRoutes } from "./routes/admin/galleries.ts";
import { uploadRoutes } from "./routes/admin/uploads.ts";
import { exportRoutes } from "./routes/admin/export.ts";
import { publicGalleryRoutes } from "./routes/gallery/public.ts";
import { systemRoutes } from "./routes/admin/system.ts";
import { photoManageRoutes } from "./routes/admin/photosManage.ts";
import { setRoutes } from "./routes/admin/sets.ts";
import { accountRoutes } from "./routes/admin/account.ts";
import { settingsRoutes } from "./routes/admin/settings.ts";
import { networkRoutes } from "./routes/admin/network.ts";
import { publicNetworkRoutes } from "./routes/network.ts";
import { MAX_UPLOAD_FILE_SIZE_BYTES } from "./services/settings.ts";

const WEB_DIST = resolve(process.cwd(), "dist/web");

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.isProduction ? "info" : "debug",
      transport: config.isProduction ? undefined : { target: "pino-pretty" },
    },
    // In production the default per-request logging would emit two lines for
    // every thumbnail a browsing session loads (hundreds per gallery view) —
    // the custom onResponse hook below logs selectively instead.
    disableRequestLogging: config.isProduction,
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024, // 1MB default for JSON bodies; uploads use multipart's own limit
    // Without this, an open SSE connection (admin upload-progress stream)
    // keeps app.close() waiting forever and every shutdown ends in SIGKILL.
    forceCloseConnections: true,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    // Fixed hard ceiling — the operator's live-tunable per-file limit is
    // enforced in the upload handler beneath this (routes/admin/uploads.ts).
    limits: { fileSize: MAX_UPLOAD_FILE_SIZE_BYTES, files: 1 },
  });
  // Compresses text responses (the SPA bundle, JSON). Images/zips are already
  // compressed formats and are skipped by content-type.
  await app.register(fastifyCompress);

  // Minimal, zero-dependency security headers — no need for a full helmet
  // plugin for a handful of static values.
  //
  // CSP: everything is same-origin and self-hosted (fonts, the theme-init
  // script, all assets), so 'self' is tight. style 'unsafe-inline' is required
  // for React's inline style attributes (low XSS value); img allows data:
  // (ThumbHash placeholders, the favicon) and blob:. No external origins at
  // all — client galleries make zero third-party requests.
  const CSP = [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", CSP);
    return payload;
  });

  if (config.isProduction) {
    app.addHook("onResponse", async (request, reply) => {
      const url = request.raw.url ?? "";
      // Successful photo-byte and static-asset requests are pure noise at
      // this app's scale; everything else (and every error) still logs.
      if (reply.statusCode < 400 && (url.startsWith("/api/photos/") || url.startsWith("/assets/"))) {
        return;
      }
      request.log.info(
        {
          method: request.method,
          url,
          statusCode: reply.statusCode,
          responseTime: Math.round(reply.elapsedTime * 10) / 10,
        },
        "request",
      );
    });
  }

  app.get("/api/health", async () => ({ ok: true }));

  await app.register(setupRoutes);
  await app.register(adminAuthRoutes);
  await app.register(passkeyLoginRoutes);
  await app.register(passkeyManageRoutes);
  await app.register(photoRoutes);
  await app.register(galleryAdminRoutes);
  await app.register(uploadRoutes);
  await app.register(exportRoutes);
  await app.register(publicGalleryRoutes);
  await app.register(systemRoutes);
  await app.register(photoManageRoutes);
  await app.register(setRoutes);
  await app.register(accountRoutes);
  await app.register(settingsRoutes);
  await app.register(networkRoutes);
  await app.register(publicNetworkRoutes);

  if (config.isProduction && existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        // Vite assets are content-hashed → cache forever. index.html must be
        // revalidated every load, or a stale copy keeps requesting JS/CSS
        // hashes that no longer exist after a rebuild (blank app for an hour).
        // (@fastify/static v10 hands this callback the FastifyReply.)
        if (filePath.includes(`${sep}assets${sep}`)) {
          res.header("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.header("Cache-Control", "no-cache");
        }
      },
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) {
        return reply.code(404).send({ error: "not_found" });
      }
      reply.header("Cache-Control", "no-cache");
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(error);
    if (error.validation) {
      return reply.code(400).send({ error: "invalid_request", details: error.message });
    }
    const statusCode = error.statusCode ?? 500;
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? "internal_error" : (error.message ?? "error"),
    });
  });

  return app;
}
