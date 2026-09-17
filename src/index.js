import { loadConfig } from "./config.js";
import { createPinataClient } from "./pinata.js";
import { createApp } from "./app.js";

const config = loadConfig();
const app = createApp(config, createPinataClient(config));
const server = app.listen(config.port, "0.0.0.0", () => {
  process.stdout.write(
    `${JSON.stringify({ event: "listening", port: config.port })}\n`,
  );
});
server.requestTimeout = 120000;
server.headersTimeout = 30000;

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${JSON.stringify({ event: "shutdown" })}\n`);
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
  setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 10000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
