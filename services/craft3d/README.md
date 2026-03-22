# craft3d

HTTP service for rendering Three.js code to GLB and PNG snapshot grids using Playwright (headless Chromium).

## Architecture

```
craft3d/
├── src/
│   ├── index.ts                    # Entry point: register routes, init DB, start server
│   ├── server.ts                   # Hono server config
│   ├── routers/
│   │   └── jobs.ts                 # REST API for render jobs
│   ├── db/
│   │   ├── core.ts                 # BetterSqlite3 Database base class with QuerySpec pattern
│   │   ├── index.ts                # DB queries for render_jobs schema
│   │   ├── queries/                # SQL files for each query
│   │   └── migrations/
│   │       └── 0001_init.sql       # Schema: render_jobs + render_artifacts
│   ├── renderer/
│   │   ├── browser.ts              # Playwright browser singleton + page factory
│   │   ├── execute-code.ts         # TypeScript transpile → browser execute → GLB
│   │   └── render-snapshots.ts     # GLB → PNG snapshot grid
│   └── lib/
│       ├── middlewares/
│       │   └── route-logger.ts     # Request logger middleware
│       └── utils/
│           ├── error-handle.ts     # Error stringification
│           └── generate-random-id.ts # UUID-based random ID generator
├── browser/
│   └── renderer.html               # Unified browser-side renderer (Three.js via unpkg CDN)
├── package.json
├── tsconfig.json
└── nodemon.json
```

## Database Schema

Two tables:

**`render_jobs`** — one row per job, tracks both the code execution phase and the snapshot phase independently.

| Column | Type | Description |
|---|---|---|
| `id` | TEXT | Primary key |
| `status` | TEXT | Code execution: `pending` \| `processing` \| `completed` \| `failed` |
| `error` | TEXT | Code execution error message (if failed) |
| `snapshot_status` | TEXT | Snapshot phase: `none` \| `pending` \| `processing` \| `completed` \| `failed` |
| `snapshot_error` | TEXT | Snapshot error message (if failed) |
| `created_at` | INTEGER | Unix ms |
| `updated_at` | INTEGER | Unix ms, auto-updated via trigger |

**`render_artifacts`** — stores input and output blobs for a job.

| `role` | Content |
|---|---|
| `input_code` | Submitted TypeScript source (`text/plain`) |
| `output_glb` | Generated GLB binary (`model/gltf-binary`) |
| `output_snapshot` | PNG snapshot grid (`image/png`) |

## API

### `POST /render` ⭐ Synchronous convenience endpoint

Submit Three.js TypeScript code and receive the rendered GLB and PNG snapshot in a single synchronous response. Internally creates a job, runs both rendering phases, then returns artifacts as base64 strings. The job record is retained in the database and accessible via the `/jobs` API.

**Request body:**
```json
{
  "code": "const mesh = new THREE.Mesh(...); __export(mesh);",
  "timeoutSec": 60
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `code` | string | required | TypeScript code using Three.js. Must call `__export(object3D)`. |
| `timeoutSec` | number | `60` | Execution timeout in seconds (1–120). |

**Success response (200):**
```json
{
  "success": true,
  "job_id": "abc123",
  "glb": "<base64-encoded GLB binary>",
  "snapshot": "<base64-encoded PNG binary>"
}
```

**Failure response (422):**
```json
{
  "success": false,
  "error": "ReferenceError: unknown identifier ..."
}
```

---

### `POST /jobs`

Create a new render job. Submits Three.js TypeScript code for execution.

**Request body:**
```json
{
  "code": "const mesh = new THREE.Mesh(...); __export(mesh);",
  "snapshots": true
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `code` | string | required | TypeScript code using Three.js. Must call `__export(object3D)` to export the result. |
| `snapshots` | boolean | `true` | Whether to render a PNG snapshot grid after GLB generation. Set to `false` to skip and trigger later via `POST /jobs/:id/snapshot`. |

**Response:** `202 Accepted` — job object.

---

### `GET /jobs`

List jobs ordered by `created_at DESC`.

**Query params:** `?limit=20&offset=0`

---

### `GET /jobs/:id`

Get job status.

**Response:**
```json
{
  "id": "abc123",
  "status": "completed",
  "error": null,
  "snapshot_status": "completed",
  "snapshot_error": null,
  "created_at": 1700000000000,
  "updated_at": 1700000001000
}
```

---

### `GET /jobs/:id/wait`

Long-poll until both `status` and `snapshot_status` reach a terminal state.

A terminal state is: `status` is `completed` or `failed`, AND `snapshot_status` is `none`, `completed`, or `failed`.

**Query params:** `?timeout_sec=30` (max 120)

**Response:** job object. Returns `202` if timed out before completion.

---

### `GET /jobs/:id/glb`

Download the generated GLB file.

- Returns `409` if `status !== 'completed'`
- Content-Type: `model/gltf-binary`

---

### `GET /jobs/:id/snapshot`

Download the PNG snapshot grid.

- Returns `404` if `snapshot_status === 'none'` (snapshots were not requested)
- Returns `409` if `snapshot_status !== 'completed'`
- Content-Type: `image/png`

---

### `POST /jobs/:id/snapshot`

Trigger snapshot rendering for a job that was created with `snapshots: false`, or retry after a failed snapshot.

- Returns `409` if the job is not yet `completed` (GLB must exist first)
- Returns `409` if snapshot is already `pending`, `processing`, or `completed`
- Returns `202` with the updated job object

---

### `DELETE /jobs/:id`

Delete a job and all its artifacts.

---

### `GET /healthz`

Health check. Returns `{ status: "ok", uptime: number }`.

---

## How Rendering Works

### Phase 1 — Code → GLB

1. The submitted TypeScript is transpiled to plain JS via the TypeScript compiler API (`ModuleKind.None`).
2. A fresh Playwright browser context is created from the shared Chromium process.
3. The JS is injected into `browser/renderer.html` via `page.evaluate()`.
4. The page has `THREE`, `GLTFExporter`, and a global `__export(object3D)` function in scope.
5. The user code calls `__export(mesh)` to hand off the result.
6. `GLTFExporter` converts it to a binary GLB, returned as base64.
7. The browser context is closed. The GLB is saved to the database.

### Phase 2 — GLB → Snapshot

1. The GLB is loaded in a fresh Playwright browser context.
2. 16 camera positions are computed on a double-helix path around the object's bounding sphere, covering both poles and all azimuths.
3. Each view is rendered with Three.js WebGL and captured as a PNG data URL.
4. `sharp` composites the 16 images into a single PNG grid (best-fit aspect ratio layout).
5. The grid is saved to the database.

Each phase uses a fresh Playwright browser context (isolated per job). The Chromium browser process is shared and kept alive for the lifetime of the server.

### User Code API

The code runs in a real browser environment (Chromium + WebGL). Available globals:

| Global | Description |
|---|---|
| `THREE` | Three.js r0.182 |
| `GLTFExporter` | `THREE.GLTFExporter` for manual export if needed |
| `__export(object3D)` | **Required.** Call with the `Object3D` (mesh, group, scene) to export as GLB. |

Example:
```typescript
const geometry = new THREE.TorusKnotGeometry(1, 0.3, 128, 32);
const material = new THREE.MeshStandardMaterial({ color: 0x4488ff, roughness: 0.3 });
const mesh = new THREE.Mesh(geometry, material);
__export(mesh);
```

## Development

```bash
npm install       # also runs: playwright install --with-deps chromium
npm run dev
```

Server listens on port `3601` by default (configurable via `PORT` env var).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3601` | HTTP server port |
| `DEBUG` | `*,-pw:*` | Debug log namespaces (uses the `debug` package) |
