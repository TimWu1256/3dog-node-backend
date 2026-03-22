import { Hono } from "hono";
import debug from "debug";
import { createRouterLogger } from "./lib/middlewares/route-logger.js";

const log = debug("craft3d:server");

export function createServer() {
  const app = new Hono();
  app.use("*", createRouterLogger(log));
  return app;
}
