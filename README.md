# POIDH IPFS service

Standalone Node.js 22 / Express upload API for Railway, replacing the Google Cloud Function in `pics-or-it/server/src/gcf.ts`. Images and metadata still live on **public IPFS through Pinata**. No database, persistent volume, or Google credentials are needed.

## Compatibility

| Endpoint | Request | Success |
| --- | --- | --- |
| `POST /uploadFile` | Multipart form with one file named `image` | Pinata JSON, including `IpfsHash`, `PinSize`, `Timestamp` |
| `POST /uploadMetadata` | JSON `{ "metadata": { ... } }` | Same Pinata response format |
| `GET /health` | None | `{ "status": "ok" }` |

Both POST endpoints now require `Authorization: Bearer <API_BEARER_TOKEN>`. This is a breaking authentication change: existing clients must add the header. `/health` and browser CORS preflight remain public.

The frontend's existing `res.IpfsHash` usage works unchanged. Metadata requires `name`, `description`, `image`, `external_url` (strings), and `attributes` (array). Attributes require string `trait_type` and `value`, matching the old schema. Additional metadata properties are preserved. Metadata is pinned as the metadata object itself, not the outer request envelope.

Uses Pinata's documented public-IPFS `pinFileToIPFS` and `pinJSONToIPFS` endpoints through native fetch, avoiding the old SDK dependency. Does not fetch arbitrary client-supplied URLs or change image bytes. Filenames are normalized to `image.<detected extension>`.

## Local development

```sh
npm ci
cp .env.example .env
# Fill in your Pinata credential and API_BEARER_TOKEN in .env; do not commit them.
npm run dev
```

`npm start` expects environment variables supplied by the host. For a local non-watch process use `node --env-file=.env src/index.js`.

```sh
curl http://localhost:3001/health
# Set API_BEARER_TOKEN in this shell as well (the service's .env is not loaded by curl).
curl -H "Authorization: Bearer $API_BEARER_TOKEN" \
  -F 'image=@/path/to/image.png' http://localhost:3001/uploadFile
curl -H "Authorization: Bearer $API_BEARER_TOKEN" -H 'Content-Type: application/json' \
  -d '{"metadata":{"name":"Receipt","description":"Proof","image":"ipfs://YOUR_IMAGE_CID","external_url":"https://poidh.xyz","attributes":[]}}' \
  http://localhost:3001/uploadMetadata
```

Upload commands create real pins and consume your Pinata quota. Tests use mocks and never contact Pinata:

```sh
npm run check
npm test
```

## Bearer authentication

Generate a random API token locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Set it as `API_BEARER_TOKEN` in Railway Variables or local `.env`, then give authorized clients that token. Never use your Pinata JWT as the client token. Startup fails if the API token is missing or malformed (32–256 URL-safe characters). Use HTTPS outside local development.

Clients send the header on **both** upload requests:

```ts
const headers = { Authorization: `Bearer ${apiToken}` };
await axios.post(`${apiUrl}/uploadFile`, formData, { headers });
await axios.post(`${apiUrl}/uploadMetadata`, { metadata }, { headers });
```

The server checks the token before parsing bodies, then performs the existing validation and Pinata upload. Missing, malformed, or incorrect tokens return `401`; repeated requests can hit `429`. Tokens in query strings or bodies are not accepted. The client token is not forwarded to Pinata.

This is a **shared, reusable API key**, not a signed URL, expiring JWT, one-time token, or user login. Anyone who has it can call either upload endpoint. Tokens delivered to browsers are visible in developer tools and can be copied; frontend environment variables do not hide them. Do not embed a private permanent token in a public frontend. For a public app, use a trusted backend proxy or add an authenticated short-lived token flow before exposing uploads. CORS and this shared key cannot prove requests came from your frontend.

Rotate by replacing `API_BEARER_TOKEN` in Railway and restarting/redeploying, then updating clients. The old token stops working on instances running the new configuration; there is no per-client revocation or overlap window. Neither API nor Pinata tokens should be logged.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `API_BEARER_TOKEN` | Required, random shared API token, separate from Pinata credentials |
| `PINATA_JWT` | Preferred server-only credential; pin-file and pin-JSON permissions required |
| `PINATA_KEY`, `PINATA_SECRET` | Alternative existing credentials; JWT takes precedence |
| `PORT` | `3001`; Railway supplies its port automatically |
| `ALLOWED_ORIGINS` | `https://poidh.xyz,https://*.poidh.xyz`; comma-separated HTTP(S) origins, optional leading subdomain wildcard, no trailing slash |
| `MAX_FILE_SIZE_BYTES` | `30485760`, matching the old Cloud Function |
| `MAX_CONCURRENT_UPLOADS` | `4` per process; extra file uploads receive 503 |
| `RATE_LIMIT_MAX` | `10` upload requests per IP per window; both endpoints share the quota |
| `RATE_LIMIT_WINDOW_MS` | `900000` (15 minutes) |
| `PINATA_TIMEOUT_MS` | `60000`; upstream timeout produces 504 |
| `TRUST_PROXY_HOPS` | `0` for direct connections; configure for your verified Railway proxy path |

`https://*.poidh.xyz` allows HTTPS subdomains, including nested ones such as `preview.app.poidh.xyz`, on the default HTTPS port. It does not include the root `https://poidh.xyz`, HTTP origins, or custom ports; list those explicitly if needed. Lookalike domains such as `poidh.xyz.evil.com` are rejected. Wildcards trust every matching subdomain, so use exact origins if any subdomain hosts untrusted users or third-party content. Bearer authentication remains required.

## Deploy to Railway

1. Push this directory to a Git repository and connect it to a new Railway service. If it is a standalone repository, use repository root. If using a monorepo, set the service root to this directory and select its `railway.json` as the config file if necessary.
2. Railway builds the included Dockerfile. It installs locked production dependencies, runs as a non-root user, and starts `node src/index.js`. No build script or disk volume is necessary. `.env` files are excluded from the image.
3. Add `PINATA_JWT` **from the existing Pinata account**, or its existing key/secret pair, plus a separately generated `API_BEARER_TOKEN`, in Railway Variables. Do not paste secrets into source code or chat.
4. Set `ALLOWED_ORIGINS=https://poidh.xyz,https://*.poidh.xyz` to allow the root and all HTTPS subdomains, or list exact origins for narrower access. Leave localhost out of production. An existing Railway variable overrides the defaults and must be updated explicitly.
5. Configure `TRUST_PROXY_HOPS` for the actual ingress path. `1` is appropriate only when there is exactly one trusted proxy between clients and the app. Confirm with Railway's current networking behavior and any additional CDN. Never blindly trust all forwarded headers: over-trusting allows IP spoofing; leaving `0` behind a proxy can rate-limit all users together. Verify distinct clients get distinct rate-limit buckets before cutover.
6. Deploy and generate a public Railway domain. `/health` is configured in `railway.json`. It checks process liveness, not Pinata credentials or upstream availability. The process listens on `0.0.0.0:$PORT` and writes operational events to stdout/stderr.
7. Start with **one replica**. Rate-limit counters and concurrency controls are in-memory and reset on restart. Multiple replicas require shared rate limiting for a global quota. Four maximum-size uploads plus multipart/Blob copies require substantially more than 120 MB RAM; size the instance conservatively or reduce concurrency.
8. Test an actual image and metadata upload, then retrieve both CIDs through your existing Pinata gateway. Check browser preflight and a complete claim-creation flow in a safe environment.

## Request logs and debugging

Open the service's deployment logs in Railway. The API writes one JSON object per line to stdout, including health checks and CORS preflight requests. No extra configuration is needed.

- `request_started` / `request_completed`: generated `requestId`, method, known route, HTTP status, and elapsed `durationMs`.
- `request_aborted`: client disconnected before completion; status is `null` rather than a misleading 200. An in-flight Pinata operation may still finish afterward with the same ID.
- `auth_rejected`: missing or invalid token, without the token itself.
- `origin_rejected`: CORS allowlist rejection, without echoing the supplied origin.
- `image_validated`: detected MIME type and byte size; `metadata_validated` marks successful schema validation.
- `pinata_request_started` / `pinata_request_completed` / `pinata_request_failed`: operation, elapsed time, upstream HTTP status when available, and a safe failure category. A Pinata 401/403 suggests credentials/permissions; 429 indicates an upstream limit. Network and timeout failures are distinguished.

Every response includes `X-Request-ID`, also exposed to browser JavaScript through CORS. Find that ID in the browser Network panel and search the Railway logs to follow the request through the Pinata call. IDs are generated by the server, not copied from incoming headers. Authentication, validation, and rate-limit failures are visible through the completion status even when no Pinata request occurred.

Logs deliberately exclude authorization/cookie headers, API keys, raw errors, query strings, arbitrary unknown paths, client IPs, filenames, CIDs, metadata contents, and image bytes. Unknown endpoints appear as `route: "unknown"`. Do not add raw request/response dumps for debugging; they can expose credentials and user content. Log volume includes two records per health check, so configure Railway log retention accordingly.

## Frontend cutover

No files in `pics-or-it` are modified by this project. In `pics-or-it/app/src/api/index.js`, replace the hardcoded Cloud Function selection with:

```js
const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:3001';
```

Update both upload calls to send the Bearer header as described above. Decide how clients obtain the token; this service has no token-issuing endpoint. Do not treat a token bundled into a public frontend as secret.

Set `REACT_APP_API_URL=https://YOUR-SERVICE.up.railway.app` in the **frontend build environment**, without a trailing slash, then rebuild/redeploy the frontend. This is a public API address, not a secret. Production must explicitly set it to avoid the localhost fallback.

Keep the existing Pinata account and gateway during this migration. `CreateClaim.js` passes gateway-based metadata URLs to the contract; moving only the API does not require rewriting those URLs or migrating existing CIDs. A different Pinata account would require separately pinning old content and checking gateway availability.

Leave the Google Cloud Function deployed during verification. If needed, restore its URL and rebuild the frontend to roll back. After successful production uploads, metadata retrieval, and claim creation, retire the old function. This project replaces only the upload API, not frontend hosting or unrelated Google Cloud resources.

## Safety and deliberate limitations

- Uploads require a shared Bearer token, not individual user authentication. Requests without an Origin header still require the token. Scripts can forge Origin. IP rate limits do not stop distributed abuse or guarantee a billing cap. Use Pinata billing controls and add wallet-signature authentication/user quotas if stronger protection is required.
- Allows JPEG, PNG, GIF, WebP, HEIC/HEIF based on file signatures, not claimed MIME types. SVG and arbitrary files are rejected. Signature checks are **not full image decoding, malware scanning, EXIF stripping, or moderation**; deliberately crafted/truncated files may pass. No image optimization or re-encoding is performed.
- JSON bodies are limited to 64 KB. File uploads allow exactly one `image` file and no extra form fields. This is stricter than the old function but matches the inspected frontend.
- Images are buffered in RAM within the size/concurrency limits; nothing is permanently stored on Railway. Request/header timeouts limit slow uploads. Upstream requests have a timeout; they are not automatically retried because a timeout does not prove pinning failed.
- Error responses never include raw Pinata errors or secrets. 400 = malformed/invalid input, 401 = missing/invalid Bearer token, 403 = denied origin, 413 = too large, 415 = unsupported request content type, 429 = rate limit, 502/504 = Pinata failure/timeout, 503 = concurrent upload capacity reached.
- Public IPFS content is public. Unpinning cannot guarantee global deletion. Do not upload confidential images.

## References

- <https://docs.pinata.cloud/api-reference/endpoint/ipfs/pin-file-to-ipfs>
- <https://docs.pinata.cloud/api-reference/endpoint/ipfs/pin-json-to-ipfs>
- <https://docs.railway.com/deployments/healthchecks>
