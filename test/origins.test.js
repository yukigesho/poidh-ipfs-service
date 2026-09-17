import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createOriginMatcher, validOriginRule } from "../src/origins.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

const env = {
  PINATA_JWT: "test-only",
  API_BEARER_TOKEN: "test-upload-token-not-for-production",
};
const allowed = [
  "https://poidh.xyz",
  "https://app.poidh.xyz",
  "https://preview.app.poidh.xyz",
];
const denied = [
  "https://poidh.xyz.evil.com",
  "https://evilpoidh.xyz",
  "https://app.poidh.xyz.evil.com",
  "http://app.poidh.xyz",
  "https://app.poidh.xyz:8443",
  "https://poidh.xyz@evil.com",
  "https://evil.com@poidh.xyz",
  "https://app.poidh.xyz/path",
  "https://app.poidh.xyz?x=1",
  "https://app.poidh.xyz#fragment",
  "https://*.poidh.xyz",
  "https://.poidh.xyz",
  "https://app..poidh.xyz",
  "https://app.poidh.xyz.",
  "null",
  "garbage",
  "",
];

test("wildcard matching respects domain boundaries, scheme and port", () => {
  const matches = createOriginMatcher(loadConfig(env).origins);
  for (const origin of allowed) assert.equal(matches(origin), true, origin);
  for (const origin of denied) assert.equal(matches(origin), false, origin);
});

test("wildcard excludes apex and exact rules do not implicitly allow subdomains", () => {
  assert.equal(
    createOriginMatcher(["https://*.poidh.xyz"])("https://poidh.xyz"),
    false,
  );
  assert.equal(
    createOriginMatcher(["https://poidh.xyz"])("https://app.poidh.xyz"),
    false,
  );
  const local = createOriginMatcher(["http://localhost:3000"]);
  assert.equal(local("http://localhost:3000"), true);
  assert.equal(local("http://localhost:3001"), false);
  const customPort = createOriginMatcher(["https://*.poidh.xyz:8443"]);
  assert.equal(customPort("https://app.poidh.xyz:8443"), true);
  assert.equal(customPort("https://app.poidh.xyz"), false);
});

test("configuration rejects broad or malformed wildcards", () => {
  for (const origin of [
    "*",
    "*.poidh.xyz",
    "https://*",
    "https://*.xyz",
    "https://*poidh.xyz",
    "https://foo.*.poidh.xyz",
    "https://*.*.poidh.xyz",
    "https://*.127.0.0.1",
    "https://*.poidh.xyz/",
    "https://*.poidh.xyz/path",
    "https://user@*.poidh.xyz",
  ]) {
    assert.equal(validOriginRule(origin), false, origin);
    assert.throws(
      () => loadConfig({ ...env, ALLOWED_ORIGINS: origin }),
      /ALLOWED_ORIGINS/,
    );
  }
});

test("allowed preflights reflect exact origin and uploads still require bearer", async () => {
  const app = createApp(loadConfig(env), {});
  for (const origin of allowed) {
    await request(app)
      .options("/uploadFile")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type")
      .expect(204)
      .expect("Access-Control-Allow-Origin", origin)
      .expect("Vary", /Origin/);
    await request(app)
      .post("/uploadMetadata")
      .set("Origin", origin)
      .send({})
      .expect(401)
      .expect("Access-Control-Allow-Origin", origin);
  }
});

test("denied origins are rejected on preflight and actual requests without CORS grants", async () => {
  const app = createApp(loadConfig(env), {});
  for (const origin of denied) {
    for (const method of ["options", "post"]) {
      const response = await request(app)
        [method]("/uploadFile")
        .set("Origin", origin)
        .expect(403);
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
  }
});
