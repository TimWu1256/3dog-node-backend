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

(async () => {
  const os = await import("os");
  const dgram = await import("node:dgram");

  function getLocalIP(remote = "8.8.8.8"): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");

      socket.once("error", (err) => {
        socket.close();
        reject(err);
      });

      socket.connect(53, remote, () => {
        const addr = socket.address();
        socket.close();

        if (typeof addr === "object") {
          resolve(addr.address);
        } else {
          reject(new Error("Cannot determine local IP"));
        }
      });
    });
  }
  async function uploadIp() {
    const ip = await getLocalIP();
    log(`ip: ${ip}`);
    try {
      const res = await fetch("https://hub.cch137.com/any-ip", {
        method: "POST",
        body: JSON.stringify({ ip }),
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error(err);
    }
  }
  uploadIp();
  setInterval(uploadIp, 10_000);
})();
