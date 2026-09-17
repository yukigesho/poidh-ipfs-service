import { isIP } from "node:net";

function parseOrigin(value) {
  try {
    const url = new URL(value);
    // Reject paths, credentials, queries, fragments, and noncanonical origins.
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== value)
      return null;
    return url;
  } catch {
    return null;
  }
}

function parseRule(value) {
  const url = parseOrigin(value);
  if (!url) return null;
  if (!url.hostname.includes("*")) return { url, wildcard: false };
  if (!url.hostname.startsWith("*.")) return null;
  const base = url.hostname.slice(2);
  const labels = base.split(".");
  if (
    isIP(base) ||
    labels.length < 2 ||
    !labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  )
    return null;
  return { url, wildcard: true };
}

export function validOriginRule(value) {
  return parseRule(value) !== null;
}

export function createOriginMatcher(origins) {
  const rules = origins.map(parseRule);
  if (rules.some((rule) => !rule)) throw new Error("Invalid origin allowlist");
  return (origin) => {
    const candidate = parseOrigin(origin);
    if (!candidate || candidate.hostname.includes("*")) return false;
    return rules.some(({ url, wildcard }) => {
      if (!wildcard) return candidate.origin === url.origin;
      const suffix = url.hostname.slice(1); // Leading dot enforces a domain boundary.
      const prefix = candidate.hostname.slice(0, -suffix.length);
      return (
        candidate.protocol === url.protocol &&
        candidate.port === url.port &&
        candidate.hostname.endsWith(suffix) &&
        prefix
          .split(".")
          .every((label) =>
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
          )
      );
    });
  };
}
