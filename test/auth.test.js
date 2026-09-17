import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";

const apiToken = "test-upload-token-not-for-production";
const env = {
  PINATA_JWT: "test-only",
  API_BEARER_TOKEN: apiToken,
  RATE_LIMIT_MAX: "100",
};

function setup() {
  const calls = [];
  const app = createApp(loadConfig(env), {
    uploadFile: async (value) => {
      calls.push(value);
      return { IpfsHash: "test" };
    },
    uploadMetadata: async (value) => {
      calls.push(value);
      return { IpfsHash: "test" };
    },
  });
  return { app, calls };
}

test("both endpoints reject missing/invalid credentials before parsing bodies", async () => {
  const { app, calls } = setup();
  for (const endpoint of ["/uploadFile", "/uploadMetadata"]) {
    for (const header of [
      undefined,
      "Basic abc",
      "Bearer",
      "Bearer wrong",
      `Bearer ${apiToken}extra`,
      `Bearer ${apiToken.toUpperCase()}`,
      `Bearer ${apiToken}, Bearer ${apiToken}`,
    ]) {
      const req = request(app).post(endpoint);
      if (header !== undefined) req.set("Authorization", header);
      await req
        .set("Content-Type", "application/json")
        .send("{")
        .expect(401, { error: "Unauthorized" })
        .expect("WWW-Authenticate", 'Bearer realm="uploads"')
        .expect("Cache-Control", "no-store");
    }
  }
  assert.equal(calls.length, 0);
});

test("tokens in query strings or JSON are not accepted", async () => {
  const { app, calls } = setup();
  await request(app)
    .post(`/uploadMetadata?token=${apiToken}`)
    .send({ token: apiToken })
    .expect(401);
  assert.equal(calls.length, 0);
});

test("duplicate Authorization headers are rejected", async () => {
  const { app } = setup();
  await request(app)
    .post("/uploadMetadata")
    .set("Authorization", [`Bearer ${apiToken}`, `Bearer ${apiToken}`])
    .send({})
    .expect(401);
});

test("valid bearer scheme is case-insensitive; token authenticates non-browser clients", async () => {
  const { app, calls } = setup();
  const metadata = {
    name: "Receipt",
    description: "Proof",
    image: "ipfs://test",
    external_url: "https://poidh.xyz",
    attributes: [],
  };
  await request(app)
    .post("/uploadMetadata")
    .set("Authorization", `bearer ${apiToken}`)
    .send({ metadata })
    .expect(200);
  assert.deepEqual(calls, [metadata]);
});

test("public health and preflight require no bearer token", async () => {
  const { app } = setup();
  await request(app).get("/health").expect(200);
  for (const endpoint of ["/uploadFile", "/uploadMetadata"]) {
    await request(app)
      .options(endpoint)
      .set("Origin", "https://poidh.xyz")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type")
      .expect(204)
      .expect("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }
});

test("startup fails closed for missing, weak, malformed, or reused API token", () => {
  for (const token of [
    undefined,
    "",
    "short",
    "x".repeat(257),
    "with spaces".repeat(4),
    "x".repeat(32) + "\n",
  ]) {
    assert.throws(
      () => loadConfig({ ...env, API_BEARER_TOKEN: token }),
      /API_BEARER_TOKEN/,
    );
  }
  assert.throws(() => loadConfig({ ...env, PINATA_JWT: apiToken }), /separate/);
  assert.throws(
    () => createApp({ ...loadConfig(env), apiBearerToken: undefined }, {}),
    /API_BEARER_TOKEN/,
  );
});
