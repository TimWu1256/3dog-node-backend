// ──────────────────────────────────────────────────────────────────────────
// DOM refs (shared)
// ──────────────────────────────────────────────────────────────────────────
const statusBadge    = document.getElementById('status-badge');
const logList        = document.getElementById('log-list');
const logContainer   = document.getElementById('log-container');
const logEmpty       = document.getElementById('log-empty');
const btnClear       = document.getElementById('btn-clear');
const btnExpandAll   = document.getElementById('btn-expand-all');
const btnExpandLabel = document.getElementById('btn-expand-all-label');
const convListView   = document.getElementById('conv-list-view');
const logView        = document.getElementById('log-view');
const backBtn        = document.getElementById('btn-back');
const hololensCountBadge  = document.getElementById('hololens-count-badge');
const hololensDevicesList = document.getElementById('hololens-devices-list');

// ──────────────────────────────────────────────────────────────────────────
// URL param routing
// ──────────────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
let convId = params.get('conv');

function navigateTo(id) {
  convId = id;
  const url = new URL(location.href);
  if (id) {
    url.searchParams.set('conv', id);
  } else {
    url.searchParams.delete('conv');
  }
  history.pushState({}, '', url.toString());
  render();
}

window.addEventListener('popstate', () => {
  convId = new URLSearchParams(location.search).get('conv');
  render();
});

// ──────────────────────────────────────────────────────────────────────────
// View switching
// ──────────────────────────────────────────────────────────────────────────
function render() {
  if (convId) {
    convListView.style.display = 'none';
    logView.style.display = 'flex';
    backBtn.style.display = '';
    stopConvList();
    stopCaptureTester();
    startLogView(convId);
  } else {
    logView.style.display = 'none';
    convListView.style.display = 'flex';
    backBtn.style.display = 'none';
    stopLogView();
    startConvList();
    startCaptureTester();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────
let ws = null;
let convListInterval = null;
let allExpanded = false;

let globalWs = null;
let globalWsReconnectTimer = null;

// Filter state
const ALL_CATS = ['session', 'message', 'text', 'transcript', 'audio', 'vad', 'response', 'tool', 'capture', 'status', 'error', 'event'];
const activeFilters = new Set(ALL_CATS);

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
// Back button
// ──────────────────────────────────────────────────────────────────────────
backBtn.addEventListener('click', () => navigateTo(null));

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
// HoloLens device list rendering
// ──────────────────────────────────────────────────────────────────────────
function renderHololensDevices(devices) {
  if (!hololensCountBadge || !hololensDevicesList) return;
  hololensCountBadge.textContent = String(devices.length);
  if (devices.length === 0) {
    hololensDevicesList.innerHTML = '<p class="text-xs text-zinc-500 py-2">No devices connected.</p>';
    setHololensStatusBadge(false);
    return;
  }
  setHololensStatusBadge(true);
  hololensDevicesList.innerHTML = devices.map(d => {
    const age = Math.round((Date.now() - d.connectedAt) / 1000);
    const ageStr = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;
    return `
      <div class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800">
        <span class="size-2 rounded-full bg-emerald-400 shrink-0"></span>
        <span class="text-sm text-zinc-100 truncate flex-1">${esc(d.deviceName)}</span>
        <span class="text-xs text-zinc-500 font-mono shrink-0">connected ${ageStr}</span>
      </div>
    `;
  }).join('');
}

// ──────────────────────────────────────────────────────────────────────────
// Log rendering helpers
// ──────────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const DIR_CFG = {
  to_api:   { label: '→ OpenAI',  cls: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20' },
  from_api: { label: '← OpenAI',  cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  sys:      { label: 'System',    cls: 'bg-zinc-800 text-zinc-500 border-zinc-700' },
};

const CAT_COLOR = {
  text:        'text-zinc-100',
  transcript:  'text-sky-300',
  audio:       'text-violet-400',
  tool:        'text-amber-400',
  capture:     'text-orange-400',
  interrupted: 'text-red-400',
  error:       'text-red-400',
  vad:         'text-teal-400',
  session:     'text-zinc-300',
  response:    'text-zinc-300',
  message:     'text-zinc-200',
  status:      'text-zinc-400',
  default:     'text-zinc-400',
};

function categorize(dir, data) {
  if (!data || typeof data !== 'object') return { cat: 'event', summary: String(data) };
  const t = data.type || '';

  if (dir === 'sys') {
    if (data.type === 'hololens.connected')    return { cat: 'capture', summary: `HoloLens connected · id: ${String(data.clientId || '').slice(0, 8)}` };
    if (data.type === 'hololens.registered')   return { cat: 'capture', summary: `HoloLens registered · "${data.deviceName}" · id: ${String(data.clientId || '').slice(0, 8)}` };
    if (data.type === 'hololens.disconnected') return { cat: 'capture', summary: `HoloLens disconnected · "${data.deviceName || data.clientId}"` };
    if (data.type === 'capture.requested') return { cat: 'capture', summary: `HoloLens capture requested · id: ${String(data.requestId || '').slice(0, 8)}${data.prompt ? ` · "${data.prompt}"` : ''}` };
    if (data.type === 'capture.ready')     return { cat: 'capture', summary: `HoloLens capture ready · id: ${String(data.requestId || '').slice(0, 8)}`, imageDataUri: data.imageBase64 };
    if (data.type === 'capture.error')     return { cat: 'capture', summary: `HoloLens capture failed · ${data.error || 'unknown'}` };
    if (data.state) return { cat: 'status', summary: data.state + (data.error ? `: ${data.error}` : '') };
    if (data.message) return { cat: 'status', summary: data.message };
    return { cat: 'status', summary: JSON.stringify(data).slice(0, 80) };
  }

  switch (t) {
    case 'session.update':
      return { cat: 'session', summary: `Update session · modalities: ${(data.session?.modalities || []).join(', ')}` };
    case 'session.created':
    case 'session.updated': {
      const s = data.session || {};
      return { cat: 'session', summary: `${t} · model: ${s.model || '?'} · voice: ${s.voice || '?'}` };
    }
    case 'conversation.item.create': {
      const item = data.item || {};
      const imgPart = item.content?.find(c => c.type === 'input_image');
      if (imgPart) return { cat: 'capture', summary: `MR photo injected into conversation · role: ${item.role || 'user'}`, imageDataUri: imgPart.image };
      const text = item.content?.find(c => c.type === 'input_text')?.text || '';
      return { cat: 'message', summary: `Create item · ${item.role} · "${text}"` };
    }
    case 'conversation.item.created': {
      const item = data.item || {};
      return { cat: 'message', summary: `Item created · ${item.role || '?'} · ${item.type || '?'}` };
    }
    case 'conversation.item.input_audio_transcription.completed':
      return { cat: 'transcript', summary: `Input transcript: "${data.transcript}"` };
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
    case 'response.create':
      return { cat: 'response', summary: 'Request response' };
    case 'response.cancel':
      return { cat: 'response', summary: 'Cancel response' };
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
    case 'response.text.delta':
      return { cat: 'text', summary: `"${data.delta}"` };
    case 'response.text.done':
      return { cat: 'text', summary: `Text done: "${(data.text || '').slice(0, 80)}"` };
    case 'response.audio.delta':
      return { cat: 'audio', summary: data.delta || '<audio chunk>' };
    case 'response.audio.done':
      return { cat: 'audio', summary: 'Audio stream done' };
    case 'response.audio_transcript.delta':
      return { cat: 'transcript', summary: `"${data.delta}"` };
    case 'response.audio_transcript.done':
      return { cat: 'transcript', summary: `Transcript done: "${(data.transcript || '').slice(0, 80)}"` };
    case 'response.function_call_arguments.delta':
      return { cat: 'tool', summary: `fn args delta: "${data.delta}"` };
    case 'response.function_call_arguments.done':
      return { cat: 'tool', summary: `fn args done: ${data.name || '?'}(${(data.arguments || '').slice(0, 60)})` };
    case 'rate_limits.updated':
      return { cat: 'status', summary: 'Rate limits updated' };
    case 'error':
      return { cat: 'error', summary: `${data.error?.type || 'error'}: ${data.error?.message || JSON.stringify(data.error)}` };
    default:
      return { cat: 'event', summary: JSON.stringify(data).slice(0, 100) };
  }
}

function truncateLargeFields(obj) {
  return JSON.parse(JSON.stringify(obj, (key, val) => {
    if (typeof val === 'string' && val.length > 200 && /^data:|^[A-Za-z0-9+/]{100}/.test(val))
      return `<base64 · ${val.length} chars>`;
    return val;
  }));
}

function appendLog({ dir, ts, data }) {
  logEmpty.style.display = 'none';
  const dcfg = DIR_CFG[dir] || DIR_CFG.sys;
  const { cat, summary, imageDataUri } = categorize(dir, data);
  const summaryColor = CAT_COLOR[cat] || CAT_COLOR.default;
  const timeStr = ts ? new Date(ts).toISOString().slice(11, 23) : '--';

  const el = document.createElement('div');
  el.className = 'log-entry group flex items-start gap-2.5 px-3 py-1.5 rounded-lg hover:bg-zinc-900/70 transition-colors duration-150';
  el.dataset.dir = dir;
  el.dataset.cat = cat;

  if (allExpanded) el.classList.add('expanded');
  if (!activeFilters.has(cat)) el.style.display = 'none';

  const imgHtml = imageDataUri
    ? `<img src="${imageDataUri}" onclick="event.stopPropagation()" class="mt-2 max-w-xs rounded-lg border border-zinc-700 cursor-default" />`
    : '';

  el.innerHTML = `
    <span class="text-xs px-1.5 py-0.5 rounded-md border font-mono shrink-0 mt-px leading-tight whitespace-nowrap ${dcfg.cls}">${esc(dcfg.label)}</span>
    <div class="flex-1 min-w-0">
      <div class="flex items-baseline gap-1.5 min-w-0">
        <span class="text-xs px-1 py-px rounded bg-zinc-800 text-zinc-500 font-mono shrink-0 leading-tight">${esc(cat)}</span>
        <span class="text-sm ${summaryColor} truncate leading-snug">${esc(summary)}</span>
      </div>
      ${imgHtml}
      <pre class="hidden mt-1.5 text-xs text-zinc-400 bg-zinc-900 border border-zinc-800 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-48 leading-relaxed select-text">${esc(JSON.stringify(truncateLargeFields(data), null, 2))}</pre>
    </div>
    <span class="text-xs text-zinc-600 shrink-0 mt-px font-mono leading-tight">${esc(timeStr)}</span>
  `;

  el.addEventListener('click', () => el.classList.toggle('expanded'));
  logList.appendChild(el);

  const { scrollTop, scrollHeight, clientHeight } = logContainer;
  if (scrollHeight - scrollTop - clientHeight < 80) {
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Log view (specific conversation)
// ──────────────────────────────────────────────────────────────────────────
function startLogView(id) {
  if (ws) ws.close();

  logList.innerHTML = '';
  logEmpty.style.display = 'flex';
  setStatus('disconnected');

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?conv=${encodeURIComponent(id)}`);

  ws.onopen = () => {
    appendLog({ dir: 'sys', ts: Date.now(), data: { type: 'ws.open', message: `Watching session: ${id}` } });
  };

  ws.onclose = (e) => {
    appendLog({ dir: 'sys', ts: Date.now(), data: { type: 'ws.close', message: `Disconnected (${e.code})` } });
    setStatus('disconnected');
    if (convId === id) setTimeout(() => startLogView(id), 3000);
  };

  ws.onerror = () => {
    appendLog({ dir: 'sys', ts: Date.now(), data: { type: 'ws.error', message: 'WebSocket error' } });
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'status') {
      setStatus(msg.state, msg.error);
      appendLog({ dir: 'sys', ts: Date.now(), data: { type: `unity.${msg.state}`, error: msg.error } });
    } else if (msg.type === 'log') {
      appendLog({ dir: msg.dir, ts: msg.ts, data: msg.data });
    } else if (msg.type === 'clear') {
      clearLog();
    }
  };
}

function stopLogView() {
  if (ws) { ws.close(); ws = null; }
  clearLog();
  setStatus('disconnected');
}

function clearLog() {
  logList.innerHTML = '';
  logEmpty.style.display = 'flex';
  allExpanded = false;
  btnExpandLabel.textContent = 'Expand All';
}

btnClear.addEventListener('click', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'clear' }));
  } else {
    clearLog();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Global WebSocket (device list + conv list push)
// ──────────────────────────────────────────────────────────────────────────
function startGlobalWs() {
  if (globalWs) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  globalWs = new WebSocket(`${proto}//${location.host}/ws`);
  globalWs.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'hololens_devices') renderHololensDevices(msg.devices);
    else if (msg.type === 'conv_list') renderConvList(msg.conversations);
  };
  globalWs.onclose = () => {
    globalWs = null;
    if (convId === null) {
      globalWsReconnectTimer = setTimeout(startGlobalWs, 3000);
    }
  };
  globalWs.onerror = () => {};
}

function stopGlobalWs() {
  clearTimeout(globalWsReconnectTimer);
  globalWsReconnectTimer = null;
  if (globalWs) { globalWs.close(); globalWs = null; }
}

// ──────────────────────────────────────────────────────────────────────────
// Conversation list view
// ──────────────────────────────────────────────────────────────────────────
const convListContainer = document.getElementById('conv-list-items');

function renderConvList(conversations) {
  if (!convListContainer) return;
  if (!conversations.length) {
    convListContainer.innerHTML = '<p class="text-zinc-500 text-sm text-center py-8">No conversations yet. Start the Unity Server to begin.</p>';
    return;
  }

  convListContainer.innerHTML = conversations.map(c => {
    const age = Math.round((Date.now() - c.createdAt) / 1000);
    const ageStr = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.round(age/60)}m ago` : `${Math.round(age/3600)}h ago`;
    const dot = c.unityConnected
      ? '<span class="size-2 rounded-full bg-emerald-400 shrink-0"></span>'
      : '<span class="size-2 rounded-full bg-zinc-600 shrink-0"></span>';
    const statusText = c.unityConnected ? 'Live' : 'Ended';
    return `
      <button onclick="navigateTo('${esc(c.id)}')"
        class="w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 hover:border-zinc-700 transition-colors duration-150">
        ${dot}
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-xs font-mono text-zinc-300 truncate">${esc(c.id)}</span>
            <span class="text-xs px-1.5 py-px rounded-full ${c.unityConnected ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-zinc-800 text-zinc-500 border border-zinc-700'}">${statusText}</span>
          </div>
          <div class="text-xs text-zinc-500 mt-0.5">${c.eventCount} events · started ${ageStr}</div>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="size-4 text-zinc-600 shrink-0"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    `;
  }).join('');
}

async function fetchConvList() {
  try {
    const res = await fetch('/api/conversations');
    const list = await res.json();
    renderConvList(list);
  } catch {
    // ignore network errors
  }
}

function startConvList() {
  fetchConvList();
  convListInterval = setInterval(fetchConvList, 3000);
  startGlobalWs();
}

function stopConvList() {
  if (convListInterval) { clearInterval(convListInterval); convListInterval = null; }
  stopGlobalWs();
}

// ──────────────────────────────────────────────────────────────────────────
// HoloLens Capture Tester
// ──────────────────────────────────────────────────────────────────────────
const btnTakePhoto       = document.getElementById('btn-take-photo');
const captureTesterStatus  = document.getElementById('capture-tester-status');
const captureTesterPreview = document.getElementById('capture-tester-preview');
const captureTesterImg     = document.getElementById('capture-tester-img');
const captureTesterMeta    = document.getElementById('capture-tester-meta');
const hololensStatusBadge  = document.getElementById('hololens-status-badge');

let hololensConnected     = false;
let captureInProgress     = false;
let captureTesterInterval = null;

function setHololensStatusBadge(connected) {
  hololensConnected = connected;
  if (connected) {
    hololensStatusBadge.className =
      'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ' +
      'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
    hololensStatusBadge.innerHTML =
      '<span class="size-1.5 rounded-full bg-emerald-400"></span>Connected';
  } else {
    hololensStatusBadge.className =
      'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ' +
      'bg-zinc-800 text-zinc-400 border border-zinc-700';
    hololensStatusBadge.innerHTML =
      '<span class="size-1.5 rounded-full bg-zinc-500"></span>Not connected';
  }
  btnTakePhoto.disabled = !connected || captureInProgress;
}

async function pollHololensStatus() {
  try {
    const res  = await fetch('/api/capture/status');
    const data = await res.json();
    setHololensStatusBadge(!!data.connected);
  } catch {
    setHololensStatusBadge(false);
  }
}

function startCaptureTester() {
  // Initial device list fetch (WS will take over once connected)
  fetch('/api/capture/devices').then(r => r.json()).then(d => renderHololensDevices(d.devices || [])).catch(() => {});
  pollHololensStatus();
  captureTesterInterval = setInterval(pollHololensStatus, 2000);
}

function stopCaptureTester() {
  if (captureTesterInterval) { clearInterval(captureTesterInterval); captureTesterInterval = null; }
}

btnTakePhoto.addEventListener('click', async () => {
  if (!hololensConnected || captureInProgress) return;

  captureInProgress = true;
  btnTakePhoto.disabled = true;
  captureTesterStatus.textContent = 'Sending capture request…';
  captureTesterPreview.classList.add('hidden');

  const requestId = Math.random().toString(36).slice(2, 12);

  // POST /api/capture/request
  let resp;
  try {
    resp = await fetch('/api/capture/request', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ requestId }),
    });
  } catch (e) {
    captureTesterStatus.textContent = `Request failed: ${e.message}`;
    captureInProgress = false;
    btnTakePhoto.disabled = !hololensConnected;
    return;
  }

  const reqData = await resp.json();
  if (!resp.ok || !reqData.ok) {
    captureTesterStatus.textContent = `Error: ${esc(reqData.error || 'unknown')}`;
    captureInProgress = false;
    btnTakePhoto.disabled = !hololensConnected;
    return;
  }

  // Poll GET /api/capture/result/:requestId (1 s intervals, 30 s timeout)
  const POLL_MAX = 30;
  let done = false;
  for (let i = 0; i < POLL_MAX && !done; i++) {
    await new Promise(r => setTimeout(r, 1000));
    captureTesterStatus.textContent = `Waiting for HoloLens… (${i + 1}s)`;

    try {
      const pollResp = await fetch(`/api/capture/result/${requestId}`);
      const poll     = await pollResp.json();

      switch (poll.status) {
        case 'ready':
          captureTesterStatus.textContent  = 'Capture successful!';
          captureTesterImg.src             = poll.imageBase64;
          captureTesterMeta.textContent    = `Captured at ${new Date().toLocaleTimeString()}`;
          captureTesterPreview.classList.remove('hidden');
          done = true;
          break;
        case 'error':
          captureTesterStatus.textContent = `HoloLens error: ${esc(poll.error || 'unknown')}`;
          done = true;
          break;
        case 'not_found':
          captureTesterStatus.textContent = 'Request not found — relay may have restarted.';
          done = true;
          break;
        // 'pending' → continue polling
      }
    } catch {
      // transient network error — keep polling
    }
  }

  if (!done) {
    captureTesterStatus.textContent = 'Timed out waiting for HoloLens capture.';
  }

  captureInProgress = false;
  btnTakePhoto.disabled = !hololensConnected;
});

// ──────────────────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────────────────
render();
