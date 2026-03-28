import { config as dotenv } from "dotenv";

dotenv();

if (!process.env.DEBUG) process.env.DEBUG = "*,-pw:*";

import debug from "debug";
import { app } from "./server"; 

const log = debug("server");

app.get("/healthz", (c) => {
  return c.json({ status: "OK" });
});

app.onError((err, c) => {
  log("app error:", err);
  return c.text("Service Unavailable", 503);
});

process.on("uncaughtException", (error) => {
  log("uncaughtException:", error);
});

process.on("unhandledRejection", (error) => {
  log("unhandledRejection:", error);
});

export default app;
