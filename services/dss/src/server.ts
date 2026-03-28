import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve } from "@hono/node-server";
import debug from "debug";
import dss from "./routers/dss";
import { createRouterLogger } from "./lib/middlewares/route-logger";

const log = debug("server");

export const app = new Hono();

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({
  app,
});

export { upgradeWebSocket };

app.route("", dss);

// simple logger: :method :url :status :res[content-length] - :response-time ms
app.use("*", createRouterLogger(log)); 

export const servers = (() => {
  const ports = new Set<number>();

  const addPort = (v?: string) => {
    if (v === undefined || v === "") return;
    const n = v ? Number.parseInt(v, 10) : NaN;
    if (Number.isInteger(n) && n > 0 && n <= 65535) ports.add(n);
    else log(`invalid port: ${v}`);
  };

  addPort(process.env.PORT);
  for (const p of (process.env.PORTS ?? "").split(",")) addPort(p.trim());

  if (ports.size === 0) ports.add(3000);

  const servers = Object.freeze(
    Array.from(ports).map((port) => {
      const server = serve({ fetch: app.fetch, port }, (info) =>
        log(`online @ http://localhost:${info.port}`),
      );
      injectWebSocket(server);
      return server;
    }),
  );

  const shutdown = (signal: string) => {
    try {
      log(`received ${signal}, shutting down...`);
      servers.forEach((server) => server.close());
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return servers;
})();
