import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import debug from "debug";
import { OpenAIRealtimeSession } from "./openai-realtime";

const log = debug("rt-demo:server");

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function safeSend(ws: WSContext, data: unknown): void {
  try {
    ws.send(JSON.stringify(data));
  } catch (err) {
    log("ws send error:", err);
  }
}

// ── Global state ────────────────────────────────────────────────────────────

const eventLog: unknown[] = [];
const clients = new Set<WSContext>();

/** Current OpenAI session — null when not connected. */
let session: OpenAIRealtimeSession | null = null;

/** Throttle for browser-dir audio log entries (ms). */
let lastAudioLogAt = 0;

function broadcast(data: unknown): void {
  for (const ws of clients) safeSend(ws, data);
}

function pushLog(entry: unknown): void {
  eventLog.push(entry);
  broadcast(entry);
}

function currentStatus(): "connected" | "connecting" | "disconnected" {
  if (!session) return "disconnected";
  return session.isConnected ? "connected" : "connecting";
}

// ── Session lifecycle ────────────────────────────────────────────────────────

function startSession(): void {
  if (session) return;

  session = new OpenAIRealtimeSession();

  session.setHandlers({
    onStatus(state, error) {
      pushLog({ type: "status", state, error });
    },
    onEvent(direction, event) {
      pushLog({ type: "log", id: uid(), ts: Date.now(), dir: direction, data: event });
    },
    onAudio(buffer) {
      // Audio frames are streamed to all clients but not stored in eventLog
      broadcast({ type: "audio", data: buffer.toString("base64") });
    },
  });

  session.connect();
}

function stopSession(): void {
  session?.destroy();
  session = null;
  pushLog({ type: "status", state: "disconnected" });
}

// ── WebSocket endpoint ──────────────────────────────────────────────────────

app.get(
  "/ws",
  upgradeWebSocket(() => {
    let clientWs: WSContext | null = null;

    return {
      onOpen(_event: Event, ws: WSContext) {
        log("browser connected");
        clientWs = ws;
        clients.add(ws);

        // Replay full event history
        for (const entry of eventLog) {
          safeSend(ws, entry);
        }

        // Push current session status so the new client is in sync
        safeSend(ws, { type: "status", state: currentStatus() });
      },

      onMessage(event: MessageEvent, _ws: WSContext) {
        let msg: { type: string; text?: string; data?: string };
        try {
          msg = JSON.parse(event.data.toString()) as typeof msg;
        } catch {
          return;
        }

        switch (msg.type) {
          case "connect_session":
            startSession();
            break;

          case "disconnect_session":
            stopSession();
            break;

          case "text_input":
            if (msg.text && session) {
              pushLog({ type: "log", id: uid(), ts: Date.now(), dir: "browser",
                data: { type: "user.text_input", text: msg.text } });
              session.sendText(msg.text);
            }
            break;

          case "audio_chunk":
            if (msg.data && session) {
              session.sendAudioChunk(msg.data);
              // Throttle: one browser-dir audio log per second
              const now = Date.now();
              if (now - lastAudioLogAt > 1000) {
                lastAudioLogAt = now;
                pushLog({ type: "log", id: uid(), ts: now, dir: "browser",
                  data: { type: "user.audio_chunk", note: "streaming PCM16 @ 24 kHz" } });
              }
            }
            break;

          case "mic_start":
            pushLog({ type: "log", id: uid(), ts: Date.now(), dir: "browser",
              data: { type: "user.mic_start", format: "PCM16 @ 24 kHz" } });
            break;

          case "mic_stop":
            lastAudioLogAt = 0; // reset throttle on stop
            pushLog({ type: "log", id: uid(), ts: Date.now(), dir: "browser",
              data: { type: "user.mic_stop" } });
            break;

          case "clear":
            eventLog.length = 0;
            broadcast({ type: "clear" });
            log("event log cleared");
            break;
        }
      },

      onClose() {
        log("browser disconnected");
        if (clientWs) clients.delete(clientWs);
        clientWs = null;
      },

      onError(event: Event) {
        log("ws error:", event);
      },
    };
  })
);

// ── Static files ────────────────────────────────────────────────────────────

app.use(
  "/*",
  serveStatic({
    root: "./public/",
    onFound(_path, c) {
      c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    },
  })
);

// ── Start server ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3681", 10);
const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  log(`online → http://localhost:${info.port}`);
});
injectWebSocket(server);

export { app };
