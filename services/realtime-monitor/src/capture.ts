import type { Hono, Context } from "hono";
import type { WSContext, UpgradeWebSocket } from "hono/ws";
import debug from "debug";

const log = debug("realtime-monitor:capture");

// ── Types ─────────────────────────────────────────────────────────────────────

interface CaptureEntry {
  status: "pending" | "ready" | "error";
  imageBase64?: string;
  error?: string;
  createdAt: number;
  /** Resolvers waiting for this entry to reach a terminal state. */
  waiters: Array<() => void>;
}

interface CaptureCommandMsg {
  type: "capture_command";
  requestId: string;
  prompt: string;
}

interface CaptureResultMsg {
  type: "capture_result";
  requestId: string;
  imageBase64: string;
}

interface CaptureErrorMsg {
  type: "capture_error";
  requestId: string;
  error: string;
}

interface HololensDevice {
  id: string;
  deviceName: string;
  ws: WSContext;
  connectedAt: number;
}

// ── State ─────────────────────────────────────────────────────────────────────

/** Pending / completed capture entries, keyed by requestId. */
const captureMap = new Map<string, CaptureEntry>();

/** Connected HoloLens devices, keyed by client id. */
const hololensDevices = new Map<string, HololensDevice>();

// Clean up stale entries every 30 s; entries older than 60 s are removed.
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [id, entry] of captureMap) {
    if (entry.createdAt < cutoff) captureMap.delete(id);
  }
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function buildDeviceList(): Array<{ id: string; deviceName: string; connectedAt: number }> {
  return [...hololensDevices.values()].map(({ id, deviceName, connectedAt }) => ({
    id,
    deviceName,
    connectedAt,
  }));
}

/** Returns the current list of connected HoloLens devices (without ws). */
export function getConnectedDevices(): Array<{ id: string; deviceName: string; connectedAt: number }> {
  return buildDeviceList();
}

// broadcastGlobal is set when mountCaptureRoutes is called
let broadcastGlobal: ((entry: unknown) => void) | undefined;

function emitDevices(): void {
  broadcastGlobal?.({ type: "hololens_devices", devices: buildDeviceList() });
}

// ── Route mounting ────────────────────────────────────────────────────────────

/**
 * Mount all capture-relay routes onto an existing Hono app.
 * Call this from server.ts after the Hono app and upgradeWebSocket are set up.
 *
 * @param broadcast Optional callback to push events to browser clients.
 *   Receives a log-entry object identical to what /ws streams to browsers.
 * @param broadcastGlobalFn Optional callback to push device-list updates to
 *   global (non-session) browser connections.
 */
export function mountCaptureRoutes(
  app: Hono,
  upgradeWebSocket: UpgradeWebSocket,
  broadcast?: (entry: unknown) => void,
  broadcastGlobalFn?: (entry: unknown) => void
): void {
  broadcastGlobal = broadcastGlobalFn;

  function emitSys(data: unknown): void {
    broadcast?.({ type: "log", dir: "sys", ts: Date.now(), data });
  }
  // ── HoloLens persistent WebSocket (GET /hololens-ws) ─────────────────────
  // The HoloLens Unity Client connects here on startup and keeps the
  // connection alive. The server pushes capture commands and receives results.
  app.get(
    "/hololens-ws",
    upgradeWebSocket((_c: Context) => {
      const clientId = uid();

      return {
        onOpen(_evt: Event, ws: WSContext) {
          hololensDevices.set(clientId, {
            id: clientId,
            deviceName: clientId,
            ws,
            connectedAt: Date.now(),
          });
          log("HoloLens connected, id:", clientId);
          emitSys({ type: "hololens.connected", clientId });
          emitDevices();
        },

        onMessage(evt: MessageEvent, _ws: WSContext) {
          let msg: CaptureResultMsg | CaptureErrorMsg | { type: string; deviceName?: string };
          try {
            msg = JSON.parse(evt.data.toString()) as typeof msg;
          } catch {
            return;
          }

          if (msg.type === "register") {
            const device = hololensDevices.get(clientId);
            if (device) {
              const deviceName = (msg as { type: string; deviceName?: string }).deviceName || clientId;
              device.deviceName = deviceName;
              log("HoloLens registered, id:", clientId, "name:", deviceName);
              emitSys({ type: "hololens.registered", clientId, deviceName });
              emitDevices();
            }
          } else if (msg.type === "capture_result") {
            const m = msg as CaptureResultMsg;
            const entry = captureMap.get(m.requestId);
            if (entry) {
              entry.status = "ready";
              entry.imageBase64 = m.imageBase64;
              const waiters = entry.waiters.splice(0);
              log("capture ready:", m.requestId);
              emitSys({ type: "capture.ready", requestId: m.requestId, imageBase64: m.imageBase64 });
              waiters.forEach((r) => r());
            }
          } else if (msg.type === "capture_error") {
            const m = msg as CaptureErrorMsg;
            const entry = captureMap.get(m.requestId);
            if (entry) {
              entry.status = "error";
              entry.error = m.error;
              const waiters = entry.waiters.splice(0);
              log("capture error:", m.requestId, m.error);
              emitSys({ type: "capture.error", requestId: m.requestId, error: m.error });
              waiters.forEach((r) => r());
            }
          }
        },

        onClose() {
          const device = hololensDevices.get(clientId);
          const deviceName = device?.deviceName ?? clientId;
          hololensDevices.delete(clientId);
          log("HoloLens disconnected, id:", clientId);
          emitSys({ type: "hololens.disconnected", clientId, deviceName });
          emitDevices();
        },

        onError(evt: Event) {
          log("HoloLens ws error:", evt);
        },
      };
    })
  );

  // ── POST /api/capture/request ─────────────────────────────────────────────
  // Called by Unity Server to trigger a capture.
  // Body: { requestId: string, prompt?: string, deviceId?: string }
  // Returns: { ok: true, requestId } | { ok: false, error: string } (503)
  app.post("/api/capture/request", async (c: Context) => {
    if (hololensDevices.size === 0) {
      return c.json({ ok: false, error: "no_hololens_connected" }, 503);
    }

    let body: { requestId?: string; prompt?: string; deviceId?: string };
    try {
      body = await c.req.json<typeof body>();
    } catch {
      return c.json({ ok: false, error: "invalid_json" }, 400);
    }

    const requestId = body.requestId;
    if (!requestId) {
      return c.json({ ok: false, error: "missing_requestId" }, 400);
    }

    // Use specified device or fall back to the most recently connected (last Map entry)
    let targetDevice: HololensDevice | undefined;
    if (body.deviceId) {
      targetDevice = hololensDevices.get(body.deviceId);
      if (!targetDevice) {
        return c.json({ ok: false, error: "device_not_found" }, 404);
      }
    } else {
      // Last entry in insertion-order Map is the most recently connected
      for (const device of hololensDevices.values()) {
        targetDevice = device;
      }
    }

    if (!targetDevice) {
      return c.json({ ok: false, error: "no_hololens_connected" }, 503);
    }

    captureMap.set(requestId, { status: "pending", createdAt: Date.now(), waiters: [] });

    const cmd: CaptureCommandMsg = {
      type: "capture_command",
      requestId,
      prompt: body.prompt ?? "",
    };
    safeSend(targetDevice.ws, cmd);
    log("capture command sent:", requestId, "to device:", targetDevice.id);
    emitSys({ type: "capture.requested", requestId, prompt: body.prompt ?? "" });

    return c.json({ ok: true, requestId });
  });

  // ── GET /api/capture/status ───────────────────────────────────────────
  // Returns whether a HoloLens device is currently connected to the relay.
  // Used by the browser test interface to enable/disable the capture button.
  // Returns: { connected: boolean }
  app.get("/api/capture/status", (c: Context) => {
    return c.json({ connected: hololensDevices.size > 0 });
  });

  // ── GET /api/capture/devices ──────────────────────────────────────────
  // Returns the list of currently connected HoloLens devices.
  // Returns: { devices: Array<{id, deviceName, connectedAt}> }
  app.get("/api/capture/devices", (c: Context) => {
    return c.json({ devices: buildDeviceList() });
  });

  // ── GET /api/capture/result/:requestId ───────────────────────────────────
  // Called by Unity Server or browser tester to poll for the capture result.
  // Supports long polling: if the entry is still pending, the request blocks
  // until the HoloLens responds or timeout_sec elapses (default 30, max 60).
  // Returns:
  //   200 { status: "ready", imageBase64: "data:image/jpeg;base64,..." }
  //   202 { status: "pending" }   — only if timeout elapsed before result arrived
  //   404 { status: "not_found" }
  //   500 { status: "error", error: string }
  app.get("/api/capture/result/:requestId", async (c: Context) => {
    const requestId = c.req.param("requestId") ?? "";
    const entry = captureMap.get(requestId);

    if (!entry) {
      return c.json({ status: "not_found" }, 404);
    }

    if (entry.status === "pending") {
      const timeoutSec = Math.min(
        60,
        Math.max(1, parseInt(c.req.query("timeout_sec") ?? "30", 10) || 30),
      );
      await new Promise<void>((resolve) => {
        let settled = false;
        const waiter = () => { settled = true; resolve(); };
        entry.waiters.push(waiter);
        setTimeout(() => {
          if (settled) return;
          const idx = entry.waiters.indexOf(waiter);
          if (idx !== -1) entry.waiters.splice(idx, 1);
          resolve();
        }, timeoutSec * 1000);
      });
    }

    switch (entry.status) {
      case "ready":
        return c.json({ status: "ready", imageBase64: entry.imageBase64 });

      case "error":
        return c.json({ status: "error", error: entry.error }, 500);

      default:
        return c.json({ status: "pending" }, 202);
    }
  });
}
