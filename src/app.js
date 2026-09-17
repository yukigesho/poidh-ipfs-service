import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import Ajv from "ajv";
import { PinataError } from "./pinata.js";
import { requireBearer } from "./auth.js";
import { createOriginMatcher } from "./origins.js";
import { logEvent, requestLogging } from "./logging.js";

const validateMetadata = new Ajv().compile({
  type: "object",
  required: ["description", "external_url", "image", "name", "attributes"],
  properties: {
    description: { type: "string" },
    external_url: { type: "string" },
    image: { type: "string" },
    name: { type: "string" },
    attributes: {
      type: "array",
      items: {
        type: "object",
        required: ["trait_type", "value"],
        properties: {
          trait_type: { type: "string" },
          value: { type: "string" },
        },
      },
    },
  },
});
const imageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

// Admission control runs before buffering files; rate limits alone don't bound RAM.
function uploadSlots(max) {
  let active = 0;
  return (_req, res, next) => {
    if (active >= max) {
      res.set("Retry-After", "5");
      return res
        .status(503)
        .json({ error: "Upload capacity reached; try again shortly" });
    }
    active++;
    let released = false;
    const release = () => {
      if (!released) {
        active--;
        released = true;
      }
    };
    res.locals.releaseUpload = release;
    res.once("finish", release);
    res.once("close", () => {
      // A disconnected client must not free a slot while Pinata still holds bytes.
      if (!res.locals.processingUpload) release();
    });
    next();
  };
}

async function detectedImage(buffer) {
  try {
    const type = await fileTypeFromBuffer(buffer);
    return type && imageTypes.has(type.mime) ? type : undefined;
  } catch {
    return undefined;
  }
}

function errorHandler(error, _req, res, _next) {
  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({
      error: status === 413 ? "File too large" : "Invalid multipart upload",
    });
  }
  if (error.type === "entity.too.large")
    return res.status(413).json({ error: "Request body too large" });
  if (error.type === "entity.parse.failed")
    return res.status(400).json({ error: "Invalid JSON" });
  if (error instanceof PinataError) {
    logEvent("pinata_error", { status: error.status });
    return res.status(error.status).json({ error: error.message });
  }
  logEvent("request_error", { status: 500 });
  return res.status(500).json({ error: "Internal server error" });
}

export function createApp(config, pinata, writeLog) {
  const app = express();
  const isAllowedOrigin = createOriginMatcher(config.origins);
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxyHops);
  app.use(requestLogging(writeLog));
  app.use(helmet());
  // Liveness only: no paid upstream request, no rate limiting.
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use((req, res, next) => {
    if (
      req.headers.origin !== undefined &&
      !isAllowedOrigin(req.headers.origin)
    ) {
      logEvent("origin_rejected");
      return res.status(403).json({ error: "Origin not allowed" });
    }
    next();
  });
  app.use(
    cors({
      origin: (origin, callback) =>
        callback(null, origin !== undefined && isAllowedOrigin(origin)),
      methods: ["POST"],
      allowedHeaders: ["Content-Type", "Authorization"],
      exposedHeaders: ["X-Request-ID"],
    }),
  );
  app.use(
    ["/uploadFile", "/uploadMetadata"],
    rateLimit({
      windowMs: config.rateLimitWindowMs,
      limit: config.rateLimitMax,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests; try again later" },
    }),
  );
  // Authenticate before either parser buffers client data or contacts Pinata.
  app.use(
    ["/uploadFile", "/uploadMetadata"],
    requireBearer(config.apiBearerToken),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxFileSize, files: 1, fields: 0, parts: 1 },
  }).single("image");

  app.post(
    "/uploadFile",
    uploadSlots(config.maxConcurrentUploads),
    (req, res, next) => {
      if (!req.is("multipart/form-data")) {
        return res.status(415).json({ error: "Expected multipart/form-data" });
      }
      // Normalize malformed multipart errors rather than leaking parser internals.
      upload(req, res, (error) => {
        if (error instanceof multer.MulterError) return next(error);
        if (error)
          return res.status(400).json({ error: "Invalid multipart upload" });
        next();
      });
    },
    async (req, res) => {
      res.locals.processingUpload = true;
      try {
        if (!req.file?.buffer?.length)
          return res.status(400).json({ error: "No file uploaded" });
        const type = await detectedImage(req.file.buffer);
        if (!type) return res.status(400).json({ error: "Invalid image type" });
        if (res.destroyed) return;
        logEvent("image_validated", {
          bytes: req.file.buffer.length,
          mimeType: type.mime,
        });
        // Trust detected bytes, not the client-supplied MIME type or extension.
        const file = {
          buffer: req.file.buffer,
          mimetype: type.mime,
          originalname: `image.${type.ext}`,
        };
        const result = await pinata.uploadFile(file);
        if (!res.destroyed) res.json(result);
      } finally {
        res.locals.releaseUpload();
      }
    },
  );
  app.post(
    "/uploadMetadata",
    express.json({ limit: "64kb" }),
    async (req, res) => {
      if (!validateMetadata(req.body?.metadata)) {
        return res.status(400).json({ error: "Invalid metadata" });
      }
      logEvent("metadata_validated");
      res.json(await pinata.uploadMetadata(req.body.metadata));
    },
  );
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);
  return app;
}
