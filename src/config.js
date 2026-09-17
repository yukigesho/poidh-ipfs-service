import { validApiToken } from "./auth.js";
import { validOriginRule } from "./origins.js";

function integer(env, name, fallback, min, max) {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  const jwt = env.PINATA_JWT?.trim();
  const key = env.PINATA_KEY?.trim();
  const secret = env.PINATA_SECRET?.trim();
  if (!jwt && !(key && secret)) {
    throw new Error("Set PINATA_JWT or both PINATA_KEY and PINATA_SECRET");
  }
  const apiBearerToken = env.API_BEARER_TOKEN;
  if (!validApiToken(apiBearerToken)) {
    throw new Error("API_BEARER_TOKEN must be 32–256 URL-safe characters");
  }
  if ([jwt, key, secret].includes(apiBearerToken)) {
    throw new Error(
      "API_BEARER_TOKEN must be separate from Pinata credentials",
    );
  }
  const origins = (
    env.ALLOWED_ORIGINS ?? "https://poidh.xyz,https://*.poidh.xyz"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!origins.length || origins.some((origin) => !validOriginRule(origin))) {
    throw new Error(
      "ALLOWED_ORIGINS must contain HTTP(S) origins or leading subdomain wildcards (https://*.poidh.xyz), without trailing slashes",
    );
  }
  return {
    apiBearerToken,
    pinataHeaders: jwt
      ? { Authorization: `Bearer ${jwt}` }
      : { pinata_api_key: key, pinata_secret_api_key: secret },
    origins,
    port: integer(env, "PORT", 3001, 1, 65535),
    // Match the old Google Cloud Function, not the 500 KB development server.
    maxFileSize: integer(env, "MAX_FILE_SIZE_BYTES", 30485760, 1, 104857600),
    maxConcurrentUploads: integer(env, "MAX_CONCURRENT_UPLOADS", 4, 1, 32),
    rateLimitMax: integer(env, "RATE_LIMIT_MAX", 10, 1, 10000),
    rateLimitWindowMs: integer(
      env,
      "RATE_LIMIT_WINDOW_MS",
      900000,
      1000,
      86400000,
    ),
    trustProxyHops: integer(env, "TRUST_PROXY_HOPS", 0, 0, 10),
    pinataTimeoutMs: integer(env, "PINATA_TIMEOUT_MS", 60000, 1000, 300000),
  };
}
