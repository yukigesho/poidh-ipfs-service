import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createPinataClient } from "../src/pinata.js";
import { requestLogging } from "../src/logging.js";

const token = "test-upload-token-not-for-production";
const config = loadConfig({
  PINATA_JWT: "private-pinata-credential",
  API_BEARER_TOKEN: token,
  RATE_LIMIT_MAX: "100",
});
const metadata = {
  name: "private-name",
  description: "private-description",
  image: "ipfs://private-image",
  external_url: "https://private.example",
  attributes: [],
};

function setup(fetchImpl) {
  const logs = [];
  const app = createApp(
    config,
    createPinataClient(config, fetchImpl),
    (record) => logs.push(record),
  );
  return { app, logs };
}

test("request and Pinata events share a generated ID without logging secrets or payloads", async () => {
  const { app, logs } = setup(async () =>
    Response.json({ IpfsHash: "private-result-cid" }),
  );
  const response = await request(app)
    .post("/uploadMetadata?secret=private-query")
    .set("Authorization", `Bearer ${token}`)
    .set("X-Request-ID", "untrusted-request-id")
    .set("Cookie", "session=private-cookie")
    .set("Origin", "https://poidh.xyz")
    .send({ metadata })
    .expect(200);
  const id = response.headers["x-request-id"];
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(
    response.headers["access-control-expose-headers"],
    "X-Request-ID",
  );
  assert.deepEqual(
    logs.map((log) => log.event),
    [
      "request_started",
      "metadata_validated",
      "pinata_request_started",
      "pinata_request_completed",
      "request_completed",
    ],
  );
  for (const log of logs) {
    assert.equal(log.requestId, id);
    assert.ok(Number.isFinite(Date.parse(log.timestamp)));
  }
  assert.equal(logs.at(-1).status, 200);
  assert.ok(logs.at(-1).durationMs >= 0);
  const text = JSON.stringify(logs);
  for (const secret of [
    token,
    config.pinataHeaders.Authorization,
    ...Object.values(metadata).filter((value) => typeof value === "string"),
    "private-query",
    "private-cookie",
    "private-result-cid",
    "untrusted-request-id",
  ]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("rejections, health and preflight are observable without raw paths or origins", async () => {
  const { app, logs } = setup(async () => {
    throw new Error("must not pin");
  });
  await request(app).get("/health").expect(200);
  await request(app)
    .options("/uploadFile")
    .set("Origin", "https://poidh.xyz")
    .set("Access-Control-Request-Method", "POST")
    .expect(204);
  await request(app).post("/uploadFile").expect(401);
  await request(app)
    .post("/uploadFile")
    .set("Authorization", "Bearer private-invalid-token")
    .expect(401);
  await request(app)
    .post("/uploadFile")
    .set("Origin", "https://private-origin.example")
    .expect(403);
  await request(app).get("/private-path?private=query").expect(404);
  const completed = logs.filter((log) => log.event === "request_completed");
  assert.deepEqual(
    completed.map((log) => log.status),
    [200, 204, 401, 401, 403, 404],
  );
  assert.equal(completed.at(-1).route, "unknown");
  assert.equal(new Set(completed.map((log) => log.requestId)).size, 6);
  assert.deepEqual(
    logs
      .filter((log) => log.event === "auth_rejected")
      .map((log) => log.reason),
    ["missing_token", "invalid_token"],
  );
  assert.equal(logs.filter((log) => log.event === "origin_rejected").length, 1);
  assert.equal(JSON.stringify(logs).includes("private-"), false);
});

test("upstream failure records status but never response body or credentials", async () => {
  const { app, logs } = setup(
    async () => new Response("private-upstream-error", { status: 403 }),
  );
  await request(app)
    .post("/uploadMetadata")
    .set("Authorization", `Bearer ${token}`)
    .send({ metadata })
    .expect(502);
  const failure = logs.find((log) => log.event === "pinata_request_failed");
  assert.equal(failure.upstreamStatus, 403);
  assert.equal(failure.reason, "upstream_error");
  assert.equal(logs.at(-1).status, 502);
  assert.equal(JSON.stringify(logs).includes("private-upstream-error"), false);
});

test("concurrent upstream requests retain independent request IDs", async () => {
  const { app, logs } = setup(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({ IpfsHash: "test" });
  });
  const responses = await Promise.all(
    [1, 2, 3].map(() =>
      request(app)
        .post("/uploadMetadata")
        .set("Authorization", `Bearer ${token}`)
        .send({ metadata })
        .expect(200),
    ),
  );
  for (const response of responses) {
    const events = logs.filter(
      (log) => log.requestId === response.headers["x-request-id"],
    );
    assert.equal(
      events.filter((log) => log.event === "pinata_request_completed").length,
      1,
    );
    assert.equal(
      events.filter((log) => log.event === "request_completed").length,
      1,
    );
  }
});

test("aborted connections log once without a misleading success status", {
  timeout: 5000,
}, async (t) => {
  const logs = [];
  let entered;
  let aborted;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const closed = new Promise((resolve) => {
    aborted = resolve;
  });
  const app = express();
  app.use(
    requestLogging((record) => {
      logs.push(record);
      if (record.event === "request_aborted") aborted();
    }),
  );
  app.get("/uploadFile", () => entered());
  const server = app.listen(0, "127.0.0.1");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, "listening");
  const controller = new AbortController();
  const response = fetch(
    `http://127.0.0.1:${server.address().port}/uploadFile`,
    { signal: controller.signal },
  );
  const rejected = assert.rejects(response, { name: "AbortError" });
  await started;
  controller.abort();
  await rejected;
  await closed;
  assert.deepEqual(
    logs.map((log) => log.event),
    ["request_started", "request_aborted"],
  );
  assert.equal(logs[1].status, null);
});
