# realtime-monitor

A browser-based development tool for the 3DOG system with two roles:

1. **Realtime API event monitor** — streams every OpenAI Realtime API packet
   forwarded by the Unity Server into a live, filterable event log.
2. **HoloLens capture relay** — maintains a persistent WebSocket connection to
   the HoloLens Unity Client and routes MR photo-capture requests between the
   Unity Server (or browser) and the device.

## Features

### Event Monitor
- **Live event log** — every event sent to or received from the OpenAI Realtime API appears in real time, categorized and color-coded
- **Filter chips** — show/hide events by category (session, message, text, transcript, audio, VAD, response, tool, capture, …)
- **Expand / Collapse All** — toggle the raw JSON payload for every log entry; individual entries are also clickable
- **Multi-client sync** — new browser tabs receive the full replay; `clear` is broadcast to all clients

### HoloLens Capture Relay
- Persistent WebSocket (`/hololens-ws`) keeps the HoloLens connected
- `POST /api/capture/request` — Unity Server triggers a capture with an optional prompt
- `GET /api/capture/result/:requestId` — poll for the returned base64 JPEG data URI
- `GET /api/capture/status` — check whether a HoloLens is currently connected
- Capture events (`capture.requested`, `capture.ready`, `capture.error`) are broadcast to all connected browser clients and appear in the event log

### Browser Capture Tester
The home page includes a **HoloLens Capture Tester** panel that lets you trigger a photo capture and preview the result directly in the browser — no Unity Server required. Useful for debugging the HoloLens capture pipeline in isolation.

## Stack

| Layer | Tech |
|---|---|
| HTTP / WebSocket server | [Hono](https://hono.dev/) + `@hono/node-server` + `@hono/node-ws` |
| Frontend | Vanilla JS + Tailwind CSS (CDN) |
| Runtime | Node.js + TypeScript (`ts-node` / compiled) |

## Getting Started

### Prerequisites

- Node.js ≥ 18

### Install

```bash
cd services/realtime-monitor
npm install
```

### Environment

Create a `.env` file in `services/realtime-monitor/`:

```env
# Optional — defaults shown below
PORT=3681
```

### Run

```bash
# Development (auto-restart on file changes)
npm run dev

# Production (compiled JS)
npm run build
npm start

# Quick run without compiling
npm run start:ts
```

Open `http://localhost:3681` in your browser.

## API Reference

### WebSocket Endpoints

| Endpoint | Client | Description |
|----------|--------|-------------|
| `GET /unity-ws?sessionId=<id>` | Unity Server | Forward Realtime API events to the monitor |
| `GET /ws?conv=<id>` | Browser | Watch a specific session's event log in real time |
| `GET /hololens-ws` | HoloLens Unity Client | Persistent capture relay connection |

### REST Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/conversations` | GET | List all known sessions |
| `/api/capture/status` | GET | `{ connected: boolean }` — HoloLens connection status |
| `/api/capture/request` | POST | Trigger a capture. Body: `{ requestId: string, prompt?: string }`. Returns `{ ok: true, requestId }` or `{ ok: false, error }` (503 if no HoloLens connected). |
| `/api/capture/result/:requestId` | GET | Poll for result: `{ status: "ready", imageBase64 }` / `{ status: "pending" }` (202) / `{ status: "error", error }` (500) / `{ status: "not_found" }` (404) |

## Architecture

```
Browser (app.js)
  │  WebSocket /ws?conv=<id>           WebSocket /hololens-ws
  ▼                                           ▲
Hono server (server.ts + capture.ts)          │
  │  maintains per-session event logs          │
  │  broadcasts capture events to browsers     │
  │                                            │
  │  WebSocket /unity-ws              HoloLens Unity Client
  ▼                                   (CaptureRelayConnection.cs)
Unity Server (3dog-rt-unity-server)
  │  forwards all OpenAI Realtime API packets
  │  calls POST /api/capture/request when AI triggers capture_photo
  └─ polls GET /api/capture/result/:requestId for the MR photo
```

### Capture Data Flow

```
[Unity Server] POST /api/capture/request { requestId, prompt }
  → server stores pending entry in captureMap
  → server sends capture_command via /hololens-ws WebSocket
  → [HoloLens] CaptureRelayConnection receives command
  → [HoloLens] MRCaptureManager.CaptureAsync() (PhotoCapture API on UWP)
  → [HoloLens] sends capture_result { requestId, imageBase64 } via WebSocket
  → server marks entry as "ready" in captureMap
  → server broadcasts capture.ready event to all browser clients
[Unity Server] GET /api/capture/result/:requestId → { status: "ready", imageBase64 }
```

### HoloLens Capture Note

On HoloLens (UWP), `MRCaptureManager` uses `PhotoCapture.CreateAsync(showHolograms: true)` — the device's native MRC API — to produce a properly composited real-world + hologram image. The previous RenderTexture + `WaitForEndOfFrame()` approach produced black images because the XR runtime controls frame submission and cameras do not reliably write to a custom `targetTexture` in XR mode.
