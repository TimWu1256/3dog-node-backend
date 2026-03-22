# realtime-demo

A browser-based demo for the [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime). It streams every WebSocket event between the browser and the OpenAI API into a live, filterable event log.

## Features

- **Live event log** — every event sent to or received from the OpenAI Realtime API appears in real time, categorized and color-coded
- **Filter chips** — show/hide events by category (session, message, text, transcript, audio, VAD, response, tool, mic, error, …)
- **Expand / Collapse All** — toggle the raw JSON payload for every log entry at once; individual entries are also clickable
- **Text input** — send text messages to the AI from the browser
- **Microphone** — capture PCM16 @ 24 kHz audio via `AudioWorklet` and stream it to the API; server-side VAD handles turn detection
- **Audio playback** — AI voice responses are decoded and played back seamlessly using the Web Audio API
- **Multi-client sync** — the server maintains a full event history; new browser tabs receive the complete replay and all clients stay in sync (including clear commands)

## Stack

| Layer | Tech |
|---|---|
| HTTP / WebSocket server | [Hono](https://hono.dev/) + `@hono/node-server` + `@hono/node-ws` |
| OpenAI transport | `ws` (native WebSocket to `wss://api.openai.com/v1/realtime`) |
| Frontend | Vanilla JS + Tailwind CSS (CDN) |
| Runtime | Node.js + TypeScript (`ts-node` / compiled) |

## Getting Started

### Prerequisites

- Node.js ≥ 18
- An OpenAI API key with access to the Realtime API

### Install

```bash
cd services/realtime-demo
npm install
```

### Environment

Create a `.env` file in `services/realtime-demo/`:

```env
OPENAI_API_KEY=sk-...

# Optional — defaults shown below
OPENAI_REALTIME_MODEL=gpt-4o-mini-realtime-preview
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

## Usage

1. Click **Connect** to open a session with the OpenAI Realtime API.
2. Type a message and press **Send** (or `Enter`) to send text.
3. Click the microphone button to stream voice input; click again to stop.
4. Watch every API event appear in the log in real time.
5. Use the filter chips to focus on specific event categories.
6. Click any log entry to expand its full JSON payload.
7. Click **Clear** to reset the event log across all connected clients.
8. Click **Disconnect** to close the OpenAI session.

## Architecture

```
Browser (app.js)
  │  WebSocket /ws
  ▼
Hono server (server.ts)
  │  maintains: eventLog[], clients Set
  │  replays history to new clients
  │  WebSocket  wss://api.openai.com/v1/realtime
  ▼
OpenAIRealtimeSession (openai-realtime.ts)
  │  session.update on connect (VAD, Whisper transcription, voice: alloy)
  │  truncates base64 audio fields in log entries
  └─ streams raw PCM16 audio buffers back to all browser clients
```

Audio flow:
- **Input** — browser `AudioWorklet` (PCM16 @ 24 kHz) → base64 → WebSocket → OpenAI `input_audio_buffer.append`
- **Output** — OpenAI `response.audio.delta` (base64 PCM16) → server → browser → `AudioContext` playback queue
