import WebSocket from "ws";
import debug from "debug";

const log = debug("rt-demo:openai");

const OPENAI_WS_URL = "wss://api.openai.com/v1/realtime";
const DEFAULT_MODEL =
  process.env.OPENAI_REALTIME_MODEL ?? "gpt-4o-mini-realtime-preview";

/** Audio format: PCM16, 24kHz mono, little-endian, base64-encoded */
export const AUDIO_SAMPLE_RATE = 24_000;

export type EventDirection = "to_api" | "from_api";

export interface OpenAIRealtimeHandlers {
  onStatus: (
    state: "connecting" | "connected" | "disconnected",
    error?: string
  ) => void;
  /** Called for every event sent to or received from the OpenAI API.
   * Large base64 audio fields are replaced with a placeholder summary. */
  onEvent: (direction: EventDirection, event: unknown) => void;
  /** Raw audio PCM16 buffer received from the API (for playback). */
  onAudio: (buffer: Buffer) => void;
}

function truncateAudioFields(event: Record<string, unknown>): unknown {
  const copy: Record<string, unknown> = { ...event };
  // input_audio_buffer.append → audio field
  if (typeof copy.audio === "string") {
    copy.audio = `<base64 PCM16 · ${copy.audio.length} chars>`;
  }
  // response.audio.delta → delta field
  if (typeof copy.delta === "string" && event.type === "response.audio.delta") {
    copy.delta = `<base64 PCM16 · ${copy.delta.length} chars>`;
  }
  return copy;
}

export class OpenAIRealtimeSession {
  private ws: WebSocket | null = null;
  private handlers: OpenAIRealtimeHandlers | null = null;
  private destroyed = false;

  setHandlers(handlers: OpenAIRealtimeHandlers): void {
    this.handlers = handlers;
  }

  connect(): void {
    if (this.destroyed) return;

    const url = `${OPENAI_WS_URL}?model=${DEFAULT_MODEL}`;
    log("connecting →", url);
    this.handlers?.onStatus("connecting");

    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    this.ws.on("open", () => {
      log("connected");
      this.handlers?.onStatus("connected");

      // Configure the session right after connecting
      this.send({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions:
            "You are a helpful AI assistant. This is a demo of the OpenAI Realtime API. Respond naturally and concisely.",
          voice: "alloy",
          input_audio_format: "pcm16",
          output_audio_format: "pcm16",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      });
    });

    this.ws.on("message", (raw: Buffer) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch (err) {
        log("message parse error:", err);
        return;
      }

      log("← OpenAI:", event.type);

      // Extract raw audio BEFORE truncating for log
      if (
        event.type === "response.audio.delta" &&
        typeof event.delta === "string" &&
        event.delta.length > 0
      ) {
        this.handlers?.onAudio(Buffer.from(event.delta, "base64"));
      }

      // Emit truncated event for log display
      this.handlers?.onEvent("from_api", truncateAudioFields(event));
    });

    this.ws.on("error", (err: Error) => {
      log("error:", err.message);
      this.handlers?.onStatus("disconnected", err.message);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      const msg = reason.toString() || `code ${code}`;
      log("closed:", msg);
      if (!this.destroyed) {
        this.handlers?.onStatus("disconnected", msg);
      }
    });
  }

  /** Send an event to OpenAI and emit it to the log (with audio fields truncated). */
  send(event: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log("cannot send — not connected");
      return;
    }
    const ev = event as Record<string, unknown>;
    this.ws.send(JSON.stringify(ev));
    log("→ OpenAI:", ev.type);
    this.handlers?.onEvent("to_api", truncateAudioFields(ev));
  }

  /** Send a text message and request a response. */
  sendText(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.send({ type: "response.create" });
  }

  /** Send a PCM16 @ 24kHz base64-encoded audio chunk. */
  sendAudioChunk(base64Audio: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: base64Audio })
    );
  }

  destroy(): void {
    this.destroyed = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
