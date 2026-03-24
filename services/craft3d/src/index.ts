import "dotenv/config";

if (!process.env.DEBUG) process.env.DEBUG = "*,-pw:*";

import debug from "debug";
import { createServer } from "./server.js";
import { connect } from "./db/index.js";
import { jobsRouter } from "./routers/jobs.js";
import { renderRouter } from "./routers/render.js";
import { serve } from "@hono/node-server";

const log = debug("craft3d");

process.on("uncaughtException", (error) => {
  log("uncaughtException:", error);
});

process.on("unhandledRejection", (error) => {
  log("unhandledRejection:", error);
});

async function main() {
  const db = await connect();
  const app = createServer();

  app.get("/healthz", (c) => c.json({ status: "ok", uptime: process.uptime() }));
  app.route("/jobs", jobsRouter(db));
  app.route("/render", renderRouter(db));

  app.onError((err, c) => {
    log("app error:", err);
    return c.json({ error: String(err), stack: err instanceof Error ? err.stack : undefined }, 503);
  });

  const port = parseInt(process.env.PORT ?? "3601", 10);
  serve({ fetch: app.fetch, port });
  log("listening on port %d", port);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
