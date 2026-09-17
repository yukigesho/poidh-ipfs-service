import { test } from "node:test";
import assert from "node:assert/strict";
import { createPinataClient } from "../src/pinata.js";
import { loadConfig } from "../src/config.js";

const apiToken = "test-upload-token-not-for-production";
const config = loadConfig({
  PINATA_JWT: "test-only",
  API_BEARER_TOKEN: apiToken,
});
const result = {
  IpfsHash: "QmTest",
  PinSize: 1,
  Timestamp: "2026-01-01T00:00:00Z",
};

test("Pinata file request uses multipart and server-only authorization", async () => {
  const client = createPinataClient(config, async (url, options) => {
    assert.equal(url, "https://api.pinata.cloud/pinning/pinFileToIPFS");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer test-only");
    assert.equal(options.headers["Content-Type"], undefined);
    const file = options.body.get("file");
    assert.equal(file.name, "image.png");
    assert.equal(file.type, "image/png");
    assert.equal(await file.text(), "image bytes");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(result);
  });
  assert.deepEqual(
    await client.uploadFile({
      buffer: Buffer.from("image bytes"),
      mimetype: "image/png",
      originalname: "image.png",
    }),
    result,
  );
});

test("metadata is wrapped in pinataContent, not pinned as the API request envelope", async () => {
  const metadata = { image: "ipfs://QmImage", name: "Receipt" };
  const client = createPinataClient(config, async (url, options) => {
    assert.equal(url, "https://api.pinata.cloud/pinning/pinJSONToIPFS");
    assert.deepEqual(JSON.parse(options.body), { pinataContent: metadata });
    assert.equal(options.headers["Content-Type"], "application/json");
    return Response.json(result);
  });
  assert.deepEqual(await client.uploadMetadata(metadata), result);
});

test("upstream errors and invalid responses never expose response bodies", async () => {
  for (const response of [
    new Response("secret details", { status: 401 }),
    Response.json({}),
    new Response("not JSON"),
  ]) {
    const client = createPinataClient(config, async () => response);
    await assert.rejects(
      client.uploadMetadata({}),
      (error) => error.status === 502 && !error.message.includes("secret"),
    );
  }
});

test("network and timeout failures map to safe gateway errors", async () => {
  for (const [name, status] of [
    ["TimeoutError", 504],
    ["TypeError", 502],
  ]) {
    const client = createPinataClient(config, async () => {
      throw Object.assign(new Error("private details"), { name });
    });
    await assert.rejects(
      client.uploadMetadata({}),
      (error) => error.status === status && !error.message.includes("private"),
    );
  }
});

test("config supports existing key pair and rejects missing credentials or unsafe settings", () => {
  const legacy = loadConfig({
    PINATA_KEY: "test-key",
    PINATA_SECRET: "test-secret",
    API_BEARER_TOKEN: apiToken,
  });
  assert.deepEqual(legacy.pinataHeaders, {
    pinata_api_key: "test-key",
    pinata_secret_api_key: "test-secret",
  });
  assert.throws(() => loadConfig({}), /PINATA/);
  for (const bad of [
    { PORT: "abc" },
    { MAX_FILE_SIZE_BYTES: "-1" },
    { TRUST_PROXY_HOPS: "true" },
    { ALLOWED_ORIGINS: "*" },
  ]) {
    assert.throws(() =>
      loadConfig({
        PINATA_JWT: "test-only",
        API_BEARER_TOKEN: apiToken,
        ...bad,
      }),
    );
  }
});
