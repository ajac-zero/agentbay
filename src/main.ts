import { serve } from "@hono/node-server";
import app from "./server.ts";

const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

function getPort() {
  const rawPort = process.env.PORT;

  if (rawPort === undefined) {
    return DEFAULT_PORT;
  }

  const port = Number(rawPort);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${rawPort}`);
  }

  return port;
}

const port = getPort();
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Wolfgang listening on port ${info.port}`);
});

let isShuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  const forceExitTimer = setTimeout(() => {
    console.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  forceExitTimer.unref();

  server.close((error) => {
    clearTimeout(forceExitTimer);

    if (error) {
      console.error("Failed to close server cleanly", error);
      process.exit(1);
    }

    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
