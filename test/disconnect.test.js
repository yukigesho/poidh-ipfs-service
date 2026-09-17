import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const apiToken = "test-upload-token-not-for-production";
const headers = { Authorization: `Bearer ${apiToken}` };

function imageBody() {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const body = new FormData();
  body.append("image", new Blob([bytes], { type: "image/png" }), "image.png");
  return body;
}

test("disconnect does not release capacity while an upstream upload is pending", {
  timeout: 5000,
}, async (t) => {
  let release;
  let entered;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const app = createApp(
    {
      ...loadConfig({ PINATA_JWT: "test-only", API_BEARER_TOKEN: apiToken }),
      maxConcurrentUploads: 1,
    },
    {
      uploadFile: async () => {
        entered();
        await pending;
        return { IpfsHash: "QmTest" };
      },
    },
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(() => {
    release();
    server.closeAllConnections();
    server.close();
  });
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/uploadFile`;
  const controller = new AbortController();
  const first = fetch(url, {
    method: "POST",
    body: imageBody(),
    signal: controller.signal,
    headers,
  });
  const rejected = assert.rejects(first, { name: "AbortError" });
  await started;
  controller.abort();
  await rejected;
  // Give the HTTP server an opportunity to observe the socket closing.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const blocked = await fetch(url, {
    method: "POST",
    body: imageBody(),
    headers,
  });
  assert.equal(blocked.status, 503);
  await blocked.json();
  release();
  await new Promise((resolve) => setImmediate(resolve));
  const next = await fetch(url, { method: "POST", body: imageBody(), headers });
  assert.equal(next.status, 200);
  await next.json();
});
