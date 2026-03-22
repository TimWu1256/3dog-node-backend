// ──────────────────────────────────────────────────────────────────────────
// SVG icon snippets
// ──────────────────────────────────────────────────────────────────────────
const SVG_MIC = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`;
const SVG_MIC_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true"><line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-1"/><path d="M5 10v2a7 7 0 0 0 12 5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/></svg>`;

// ──────────────────────────────────────────────────────────────────────────
// DOM refs
// ──────────────────────────────────────────────────────────────────────────
const statusBadge    = document.getElementById('status-badge');
const logList        = document.getElementById('log-list');
const logContainer   = document.getElementById('log-container');
const logEmpty       = document.getElementById('log-empty');
const textInput      = document.getElementById('text-input');
const btnSend        = document.getElementById('btn-send');
const btnMic         = document.getElementById('btn-mic');
const btnClear       = document.getElementById('btn-clear');
const btnExpandAll   = document.getElementById('btn-expand-all');
const btnExpandLabel = document.getElementById('btn-expand-all-label');
const btnSession     = document.getElementById('btn-session');
const audioStatus    = document.getElementById('audio-status');

btnMic.innerHTML = SVG_MIC;

// ──────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────
let ws            = null;
let isRecording   = false;
let micStream     = null;
let micCtx        = null;
let playCtx       = null;
let nextPlayAt    = 0;

// Filter state — all event categories visible by default
const ALL_CATS = ['session', 'message', 'text', 'transcript', 'audio', 'vad', 'response', 'tool', 'mic', 'status', 'error', 'event'];
const activeFilters = new Set(ALL_CATS);

// Global expand/collapse state
let allExpanded = false;

// ──────────────────────────────────────────────────────────────────────────
// Filter chips
// ──────────────────────────────────────────────────────────────────────────
document.querySelectorAll('.filter-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    const cat = btn.dataset.cat;
    if (activeFilters.has(cat)) {
      activeFilters.delete(cat);
      btn.classList.add('inactive');
    } else {
      activeFilters.add(cat);
      btn.classList.remove('inactive');
    }
    // Update visibility of existing entries
    document.querySelectorAll('.log-entry').forEach(el => {
      el.style.display = activeFilters.has(el.dataset.cat) ? '' : 'none';
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Expand All / Collapse All
// ──────────────────────────────────────────────────────────────────────────
btnExpandAll.addEventListener('click', () => {
  allExpanded = !allExpanded;
  document.querySelectorAll('.log-entry').forEach(el => {
    el.classList.toggle('expanded', allExpanded);
  });
  btnExpandLabel.textContent = allExpanded ? 'Collapse All' : 'Expand All';
});

// ──────────────────────────────────────────────────────────────────────────
// Status badge
// ──────────────────────────────────────────────────────────────────────────
function setStatus(state, error) {
  const MAP = {
    connecting:   { dot: 'bg-yellow-400 animate-pulse', text: 'Connecting…',   badge: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' },
    connected:    { dot: 'bg-emerald-400',              text: 'Connected',      badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    disconnected: { dot: 'bg-zinc-500',                 text: 'Disconnected',   badge: 'bg-zinc-800 text-zinc-400 border-zinc-700' },
  };
  const cfg = MAP[state] || MAP.disconnected;
  statusBadge.className = `inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border ${cfg.badge}`;
  statusBadge.innerHTML = `<span class="size-1.5 rounded-full ${cfg.dot}"></span>${esc(error ? `Error: ${error}` : cfg.text)}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Log rendering
// ──────────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DIR_CFG = {
  browser:  { label: 'Browser',   cls: 'bg-violet-500/10 text-violet-400 border-violet-500/20' },
  to_api:   { label: '→ OpenAI',  cls: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' },
  from_api: { label: '← OpenAI',  cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  sys:      { label: 'System',    cls: 'bg-zinc-800 text-zinc-500 border-zinc-700' },
};

const CAT_COLOR = {
  text:        'text-zinc-100',
  transcript:  'text-sky-300',
  audio:       'text-violet-400',
  tool:        'text-amber-400',
  interrupted: 'text-red-400',
  error:       'text-red-400',
  vad:         'text-teal-400',
  session:     'text-zinc-300',
  response:    'text-zinc-300',
  message:     'text-zinc-200',
  mic:         'text-teal-400',
  status:      'text-zinc-400',
  default:     'text-zinc-400',
};

function categorize(dir, data) {
  if (!data || typeof data !== 'object') return { cat: 'event', summary: String(data) };

  const t = data.type || '';

  // ── Browser actions ──
  if (dir === 'browser') {
    if (t === 'user.text_input')  return { cat: 'text',  summary: `"${data.text}"` };
    if (t === 'user.mic_start')   return { cat: 'mic',   summary: `Microphone started · ${data.format || ''}` };
    if (t === 'user.mic_stop')    return { cat: 'mic',   summary: 'Microphone stopped' };
    return { cat: 'event', summary: t };
  }

  // ── System ──
  if (dir === 'sys') {
    if (data.state) return { cat: 'status', summary: data.state + (data.error ? `: ${data.error}` : '') };
    if (data.message) return { cat: 'status', summary: data.message };
    return { cat: 'status', summary: JSON.stringify(data).slice(0, 80) };
  }

  // ── API events (to_api / from_api) ──
  switch (t) {
    // Session
    case 'session.update':
      return { cat: 'session', summary: `Update session · modalities: ${(data.session?.modalities || []).join(', ')}` };
    case 'session.created':
    case 'session.updated': {
      const s = data.session || {};
      return { cat: 'session', summary: `${t} · model: ${s.model || '?'} · voice: ${s.voice || '?'}` };
    }

    // Conversation
    case 'conversation.item.create': {
      const item = data.item || {};
      const text = item.content?.find(c => c.type === 'input_text')?.text || '';
      return { cat: 'message', summary: `Create item · ${item.role} · "${text}"` };
    }
    case 'conversation.item.created': {
      const item = data.item || {};
      return { cat: 'message', summary: `Item created · ${item.role || '?'} · ${item.type || '?'}` };
    }
    case 'conversation.item.input_audio_transcription.completed':
      return { cat: 'transcript', summary: `Input transcript: "${data.transcript}"` };

    // Audio buffer
    case 'input_audio_buffer.append':
      return { cat: 'audio', summary: data.audio || '<audio data>' };
    case 'input_audio_buffer.committed':
      return { cat: 'audio', summary: 'Audio buffer committed' };
    case 'input_audio_buffer.cleared':
      return { cat: 'audio', summary: 'Audio buffer cleared' };
    case 'input_audio_buffer.speech_started':
      return { cat: 'vad', summary: `Speech detected · item: ${data.item_id || '?'}` };
    case 'input_audio_buffer.speech_stopped':
      return { cat: 'vad', summary: 'Speech ended' };

    // Response lifecycle
    case 'response.create':
      return { cat: 'response', summary: 'Request response' };
    case 'response.created':
      return { cat: 'response', summary: `Response created · id: ${data.response?.id || '?'}` };
    case 'response.done': {
      const r = data.response || {};
      return { cat: 'response', summary: `Response done · status: ${r.status || '?'} · id: ${r.id || '?'}` };
    }
    case 'response.cancelled':
      return { cat: 'response', summary: 'Response cancelled' };
    case 'response.output_item.added':
      return { cat: 'response', summary: `Output item added · ${data.item?.type || '?'}` };
    case 'response.output_item.done':
      return { cat: 'response', summary: `Output item done · ${data.item?.type || '?'}` };
    case 'response.content_part.added':
      return { cat: 'response', summary: `Content part · ${data.part?.type || '?'}` };
    case 'response.content_part.done':
      return { cat: 'response', summary: `Content part done · ${data.part?.type || '?'}` };

    // Streaming text
    case 'response.text.delta':
      return { cat: 'text', summary: `"${data.delta}"` };
    case 'response.text.done':
      return { cat: 'text', summary: `Text done: "${(data.text || '').slice(0, 80)}"` };

    // Streaming audio
    case 'response.audio.delta':
      return { cat: 'audio', summary: data.delta || '<audio chunk>' };
    case 'response.audio.done':
      return { cat: 'audio', summary: 'Audio stream done' };

    // Audio transcript
    case 'response.audio_transcript.delta':
      return { cat: 'transcript', summary: `"${data.delta}"` };
    case 'response.audio_transcript.done':
      return { cat: 'transcript', summary: `Transcript done: "${(data.transcript || '').slice(0, 80)}"` };

    // Function calls
    case 'response.function_call_arguments.delta':
      return { cat: 'tool', summary: `fn args delta: "${data.delta}"` };
    case 'response.function_call_arguments.done':
      return { cat: 'tool', summary: `fn args done: ${data.name || '?'}(${(data.arguments || '').slice(0, 60)})` };

    // Rate limits & errors
    case 'rate_limits.updated':
      return { cat: 'status', summary: 'Rate limits updated' };
    case 'error':
      return { cat: 'error', summary: `${data.error?.type || 'error'}: ${data.error?.message || JSON.stringify(data.error)}` };

    default:
      return { cat: 'event', summary: JSON.stringify(data).slice(0, 100) };
  }
}

function appendLog({ dir, ts, data }) {
  logEmpty.style.display = 'none';

  const dcfg = DIR_CFG[dir] || DIR_CFG.sys;
  const { cat, summary } = categorize(dir, data);
  const summaryColor = CAT_COLOR[cat] || CAT_COLOR.default;
  const timeStr = ts ? new Date(ts).toISOString().slice(11, 23) : '--';

  const el = document.createElement('div');
  el.className = 'log-entry group flex items-start gap-2.5 px-3 py-1.5 rounded-lg hover:bg-zinc-900/70 transition-colors duration-150';
  el.dataset.dir = dir;
  el.dataset.cat = cat;

  // Apply current global expand state
  if (allExpanded) el.classList.add('expanded');

  // Apply current filter
  if (!activeFilters.has(cat)) el.style.display = 'none';

  el.innerHTML = `
    <span class="text-xs px-1.5 py-0.5 rounded-md border font-mono shrink-0 mt-px leading-tight whitespace-nowrap ${dcfg.cls}">${esc(dcfg.label)}</span>
    <div class="flex-1 min-w-0">
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-xs px-1 py-px rounded bg-zinc-800 text-zinc-500 font-mono shrink-0 leading-tight">${esc(cat)}</span>
        <span class="text-sm ${summaryColor} truncate leading-snug">${esc(summary)}</span>
      </div>
      <pre class="hidden mt-1.5 text-xs text-zinc-400 bg-zinc-900 border border-zinc-800 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-48 leading-relaxed select-text">${esc(JSON.stringify(data, null, 2))}</pre>
    </div>
    <span class="text-xs text-zinc-600 shrink-0 mt-px font-mono leading-tight">${esc(timeStr)}</span>
  `;

  // Click to toggle expanded
  el.addEventListener('click', () => el.classList.toggle('expanded'));

  logList.appendChild(el);

  // Auto-scroll only when near the bottom
  const { scrollTop, scrollHeight, clientHeight } = logContainer;
  if (scrollHeight - scrollTop - clientHeight < 80) {
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// WebSocket connection
// ──────────────────────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    // Clear local log before replaying server history to avoid duplicates on reconnect
    logList.innerHTML = '';
    logEmpty.style.display = 'flex';
    appendLog({ dir: 'sys', ts: Date.now(), data: { type: 'ws.open', message: 'WebSocket connected to backend server' } });
  };

  ws.onclose = (e) => {
    appendLog({ dir: 'sys', ts: Date.now(), data: { type: 'ws.close', message: `Disconnected (${e.code})` } });
    setStatus('disconnected');
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    appendLog({ dir: 'sys', ts: Date.now(), data: { type: 'ws.error', message: 'WebSocket error' } });
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'status') {
      setStatus(msg.state, msg.error);
      updateSessionBtn(msg.state);
      appendLog({ dir: 'sys', ts: Date.now(), data: { type: `openai.${msg.state}`, error: msg.error } });
    } else if (msg.type === 'log') {
      appendLog({ dir: msg.dir, ts: msg.ts, data: msg.data });
    } else if (msg.type === 'audio') {
      playPCM(msg.data);
    } else if (msg.type === 'clear') {
      clearLog();
    }
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Session connect / disconnect button
// ──────────────────────────────────────────────────────────────────────────
let sessionState = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'

function updateSessionBtn(state) {
  sessionState = state;
  if (state === 'connected') {
    btnSession.textContent = 'Disconnect';
    btnSession.className = 'h-7 px-2.5 flex items-center gap-1.5 text-xs font-medium rounded-lg border transition-colors duration-150 bg-red-600/20 text-red-400 border-red-500/30 hover:bg-red-600/40';
    btnSession.disabled = false;
  } else if (state === 'connecting') {
    btnSession.textContent = 'Connecting…';
    btnSession.className = 'h-7 px-2.5 flex items-center gap-1.5 text-xs font-medium rounded-lg border transition-colors duration-150 bg-yellow-600/20 text-yellow-400 border-yellow-500/30 opacity-60 cursor-not-allowed';
    btnSession.disabled = true;
  } else {
    btnSession.textContent = 'Connect';
    btnSession.className = 'h-7 px-2.5 flex items-center gap-1.5 text-xs font-medium rounded-lg border transition-colors duration-150 bg-emerald-600/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-600/40';
    btnSession.disabled = false;
  }
}

btnSession.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (sessionState === 'disconnected') {
    ws.send(JSON.stringify({ type: 'connect_session' }));
  } else if (sessionState === 'connected') {
    ws.send(JSON.stringify({ type: 'disconnect_session' }));
  }
});

setStatus('disconnected');
updateSessionBtn('disconnected');
connect();

// ──────────────────────────────────────────────────────────────────────────
// Audio playback — PCM16 @ 24 kHz
// ──────────────────────────────────────────────────────────────────────────
const PLAY_SAMPLE_RATE = 24000;

async function getPlayCtx() {
  if (!playCtx) {
    playCtx = new AudioContext({ sampleRate: PLAY_SAMPLE_RATE });
    nextPlayAt = 0;
  }
  if (playCtx.state === 'suspended') await playCtx.resume();
  return playCtx;
}

async function playPCM(base64) {
  try {
    const ctx = await getPlayCtx();

    // Decode base64 → raw bytes
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    // Interpret as PCM16 little-endian → Float32
    const pcm16 = new Int16Array(bytes.buffer);
    const f32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i] / 32768;

    const buf = ctx.createBuffer(1, f32.length, PLAY_SAMPLE_RATE);
    buf.copyToChannel(f32, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime + 0.04, nextPlayAt);
    src.start(startAt);
    nextPlayAt = startAt + buf.duration;
  } catch (err) {
    console.error('Audio playback error:', err);
  }
}

function resetPlayback() {
  nextPlayAt = 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Text input
// ──────────────────────────────────────────────────────────────────────────
function sendText() {
  const text = textInput.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'text_input', text }));
  textInput.value = '';
}

btnSend.addEventListener('click', sendText);
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
});

// ──────────────────────────────────────────────────────────────────────────
// Microphone — PCM16 @ 24 kHz via AudioWorklet
// ──────────────────────────────────────────────────────────────────────────
const WORKLET_CODE = `
class PCMCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch?.length) {
      const i16 = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++)
        i16[i] = Math.max(-32768, Math.min(32767, Math.round(ch[i] * 32767)));
      this.port.postMessage(i16.buffer, [i16.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-capture', PCMCapture);
`;

function setMicState(recording) {
  isRecording = recording;
  btnMic.innerHTML = recording ? SVG_MIC_OFF : SVG_MIC;
  if (recording) {
    btnMic.className = 'h-9 w-9 flex items-center justify-center rounded-lg border border-red-500/40 bg-red-500/10 active:scale-95 transition-all duration-150 text-red-400 shrink-0';
    audioStatus.innerHTML = '<span class="text-red-400 animate-pulse">● Recording — PCM16 @ 24 kHz</span>';
  } else {
    btnMic.className = 'h-9 w-9 flex items-center justify-center rounded-lg border border-zinc-700 hover:bg-zinc-800 active:scale-95 transition-all duration-150 text-zinc-400 shrink-0';
    audioStatus.textContent = '';
  }
}

async function startRecording() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: { ideal: 24000 } },
    });

    micCtx = new AudioContext({ sampleRate: 24000 });

    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    await micCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    const src     = micCtx.createMediaStreamSource(micStream);
    const worklet = new AudioWorkletNode(micCtx, 'pcm-capture');

    worklet.port.onmessage = ({ data: buf }) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Convert ArrayBuffer → base64
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      ws.send(JSON.stringify({ type: 'audio_chunk', data: btoa(bin) }));
    };

    src.connect(worklet);
    // Intentionally not connecting worklet → destination (avoids feedback)

    setMicState(true);
    ws?.send(JSON.stringify({ type: 'mic_start' }));
  } catch (err) {
    appendLog({ dir: 'sys', ts: Date.now(), data: { type: 'mic.error', message: String(err) } });
  }
}

function stopRecording() {
  micStream?.getTracks().forEach(t => t.stop());
  micCtx?.close();
  micStream = null;
  micCtx    = null;
  setMicState(false);
  ws?.send(JSON.stringify({ type: 'mic_stop' }));
}

btnMic.addEventListener('click', () => {
  if (isRecording) stopRecording();
  else startRecording();
});

// Reset playback queue on "interrupted" event
document.addEventListener('openai-interrupted', resetPlayback);

// ──────────────────────────────────────────────────────────────────────────
// Clear
// ──────────────────────────────────────────────────────────────────────────
function clearLog() {
  logList.innerHTML = '';
  logEmpty.style.display = 'flex';
  allExpanded = false;
  btnExpandLabel.textContent = 'Expand All';
  resetPlayback();
}

btnClear.addEventListener('click', () => {
  // Ask the server to clear — it will broadcast to all connected clients
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'clear' }));
  } else {
    clearLog();
  }
});
