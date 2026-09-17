import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const context = new AsyncLocalStorage();
const routes = new Set(["/health", "/uploadFile", "/uploadMetadata"]);

function writeJson(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

// Callers supply only fixed event names and explicitly selected safe fields.
export function logEvent(event, fields = {}) {
  const current = context.getStore();
  const record = {
    timestamp: new Date().toISOString(),
    event,
    ...(current ? { requestId: current.requestId } : {}),
    ...fields,
  };
  (current?.writeLog ?? writeJson)(record);
}

export function requestLogging(writeLog = writeJson) {
  return (req, res, next) => {
    const requestId = randomUUID(); // Never trust client-supplied request IDs.
    const started = performance.now();
    const route = routes.has(req.path) ? req.path : "unknown";
    const method = [
      "GET",
      "POST",
      "OPTIONS",
      "HEAD",
      "PUT",
      "DELETE",
      "PATCH",
    ].includes(req.method)
      ? req.method
      : "OTHER";
    res.set("X-Request-ID", requestId);
    context.run({ requestId, writeLog }, () => {
      logEvent("request_started", { method, route });
      let completed = false;
      const finish = (aborted) => {
        if (completed) return;
        completed = true;
        // Socket callbacks can run outside their original async context.
        context.run({ requestId, writeLog }, () => {
          logEvent(aborted ? "request_aborted" : "request_completed", {
            method,
            route,
            status: aborted ? null : res.statusCode,
            durationMs: Math.round(performance.now() - started),
          });
        });
      };
      res.once("finish", () => finish(false));
      res.once("close", () => finish(!res.writableFinished));
      next();
    });
  };
}
