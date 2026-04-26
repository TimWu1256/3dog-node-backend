import { Hono } from "hono";
import type { serve } from "@hono/node-server";
import debug from "debug";
import { createRouterLogger } from "./lib/middlewares/route-logger.js";

const log = debug("craft3d:server");

export function createServer() {
  const app = new Hono();
  app.use("*", createRouterLogger(log));
  return app;
}

export function setupGracefulShutdown(server: ReturnType<typeof serve>) {
  const shutdown = (signal: string) => {
    try {
      log(`received ${signal}, shutting down...`);
      server.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
