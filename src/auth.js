import { createHash, timingSafeEqual } from "node:crypto";
import { logEvent } from "./logging.js";

export function validApiToken(token) {
  return (
    typeof token === "string" &&
    token.length >= 32 &&
    token.length <= 256 &&
    !/[^A-Za-z0-9_-]/.test(token)
  );
}

function digest(token) {
  return createHash("sha256").update(token).digest();
}

export function requireBearer(token) {
  if (!validApiToken(token)) {
    throw new Error("API_BEARER_TOKEN must be 32–256 URL-safe characters");
  }
  const expected = digest(token);
  return (req, res, next) => {
    // Reject duplicate headers rather than relying on Node's header selection.
    const headers = req.headersDistinct.authorization ?? [];
    const match =
      headers.length === 1
        ? /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(headers[0])
        : null;
    if (!match || !timingSafeEqual(digest(match[1]), expected)) {
      logEvent("auth_rejected", {
        reason: headers.length === 0 ? "missing_token" : "invalid_token",
      });
      res.set("WWW-Authenticate", 'Bearer realm="uploads"');
      res.set("Cache-Control", "no-store");
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };
}
