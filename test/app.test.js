import { test } from "node:test";
import assert from "node:assert/strict";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { PinataError } from "../src/pinata.js";

const apiToken = "test-upload-token-not-for-production";
function request(app) {
  return supertest.agent(app).set("Authorization", `Bearer ${apiToken}`);
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const result = {
  IpfsHash: "QmTest",
  PinSize: 68,
  Timestamp: "2026-01-01T00:00:00Z",
};
const metadata = {
  name: "Receipt",
  description: "Proof",
  image: "ipfs://QmImage",
  external_url: "https://poidh.xyz",
  attributes: [],
};
function setup(overrides = {}, client = {}) {
  const calls = [];
  const config = {
    ...loadConfig({
      PINATA_JWT: "test-only",
      API_BEARER_TOKEN: apiToken,
      RATE_LIMIT_MAX: "100",
    }),
    ...overrides,
  };
  const app = createApp(config, {
    uploadFile: async (file) => {
      calls.push(file);
      return result;
    },
    uploadMetadata: async (value) => {
      calls.push(value);
      return result;
    },
    ...client,
  });
  return { app, calls };
}

test("health is independent of uploads and rate limits", async () => {
  const { app, calls } = setup({ rateLimitMax: 1 });
  await request(app).post("/uploadMetadata").send({}).expect(400);
  await request(app).post("/uploadMetadata").send({}).expect(429);
  await supertest(app).get("/health").expect(200, { status: "ok" });
  assert.equal(calls.length, 0);
});

test("uploads image field, detects MIME from bytes, preserves IpfsHash", async () => {
  const { app, calls } = setup();
  await request(app)
    .post("/uploadFile")
    .attach("image", png, {
      filename: "untrusted.txt",
      contentType: "text/plain",
    })
    .expect(200, result);
  assert.equal(calls[0].mimetype, "image/png");
  assert.equal(calls[0].originalname, "image.png");
  assert.deepEqual(calls[0].buffer, png);
});

test("rejects missing, fake, oversized, unexpected and multiple files without pinning", async () => {
  const { app, calls } = setup({ maxFileSize: 100 });
  await request(app).post("/uploadFile").send({}).expect(415);
  await request(app)
    .post("/uploadFile")
    .attach("image", Buffer.alloc(0), "empty.png")
    .expect(400);
  await request(app)
    .post("/uploadFile")
    .attach("image", Buffer.from("not an image"), "fake.png")
    .expect(400);
  await request(app)
    .post("/uploadFile")
    .attach("image", Buffer.alloc(101), "huge.png")
    .expect(413);
  await request(app)
    .post("/uploadFile")
    .attach("file", png, "test.png")
    .expect(400);
  await request(app)
    .post("/uploadFile")
    .attach("image", png, "one.png")
    .attach("image", png, "two.png")
    .expect(400);
  assert.equal(calls.length, 0);
});

test("malformed multipart has a controlled JSON error", async () => {
  const { app } = setup();
  await request(app)
    .post("/uploadFile")
    .set("Content-Type", "multipart/form-data")
    .send("broken")
    .expect(400, { error: "Invalid multipart upload" });
});

test("pins unchanged metadata and rejects invalid or oversized JSON", async () => {
  const { app, calls } = setup();
  await request(app)
    .post("/uploadMetadata")
    .send({ metadata })
    .expect(200, result);
  assert.deepEqual(calls[0], metadata);
  for (const invalid of [
    null,
    [],
    {},
    { ...metadata, attributes: [{ value: "missing trait" }] },
  ]) {
    await request(app)
      .post("/uploadMetadata")
      .send({ metadata: invalid })
      .expect(400);
  }
  await request(app)
    .post("/uploadMetadata")
    .set("Content-Type", "application/json")
    .send("{")
    .expect(400);
  await request(app)
    .post("/uploadMetadata")
    .send({ metadata: { ...metadata, description: "x".repeat(70000) } })
    .expect(413);
  assert.equal(calls.length, 1);
});

test("CORS preflight works and disallowed origins are rejected", async () => {
  const { app } = setup();
  await supertest(app)
    .options("/uploadFile")
    .set("Origin", "https://poidh.xyz")
    .set("Access-Control-Request-Method", "POST")
    .set("Access-Control-Request-Headers", "authorization,content-type")
    .expect("Access-Control-Allow-Headers", "Content-Type,Authorization")
    .expect(204)
    .expect("Access-Control-Allow-Origin", "https://poidh.xyz");
  await request(app)
    .post("/uploadMetadata")
    .set("Origin", "https://evil.example")
    .send({ metadata })
    .expect(403);
});

test("provider errors are safe and release upload capacity", async () => {
  const { app } = setup(
    { maxConcurrentUploads: 1 },
    {
      uploadFile: async () => {
        throw new PinataError(504, "Pinata upload timed out");
      },
    },
  );
  for (let i = 0; i < 2; i++) {
    await request(app)
      .post("/uploadFile")
      .attach("image", png, "test.png")
      .expect(504, { error: "Pinata upload timed out" });
  }
});

test("concurrent file uploads are bounded", async () => {
  let release;
  let entered;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const { app } = setup(
    { maxConcurrentUploads: 1 },
    {
      uploadFile: async () => {
        entered();
        await pending;
        return result;
      },
    },
  );
  const first = request(app)
    .post("/uploadFile")
    .attach("image", png, "first.png")
    .then((response) => response);
  await started;
  try {
    await request(app)
      .post("/uploadFile")
      .attach("image", png, "second.png")
      .expect(503);
  } finally {
    release();
  }
  assert.equal((await first).status, 200);
  await request(app)
    .post("/uploadFile")
    .attach("image", png, "third.png")
    .expect(200);
});
