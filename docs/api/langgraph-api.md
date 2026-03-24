# LangGraph Server API 參考

LangGraph Server 由 `langgraph-cli` 啟動，預設 port **2024**（本專案使用 **3600**）。

---

## 核心概念

| 概念 | 說明 |
|------|------|
| **Assistant** | 對應一個 graph（定義於 `langgraph.json`），有唯一 `assistant_id` |
| **Thread** | 有狀態的對話容器，每次 run 的 checkpoint 都存在這裡 |
| **Run** | 一次 graph 執行，可同步等待或非同步輪詢 |
| **Output schema** | graph 定義了 `output=` 時，`/runs/wait` 與 stream 只回傳指定欄位 |

---

## 本專案 Assistant

| assistant_id | graph | 說明 |
|---|---|---|
| `craft3d` | `agents_server.graphs.craft3d.graph:craft3d_agent` | 文字描述 → 3D GLB |

---

## Endpoints

### Threads

| Method | Path | 說明 |
|--------|------|------|
| `POST` | `/threads` | 建立新 thread，回傳 `{ thread_id }` |
| `GET` | `/threads/{thread_id}` | 取得 thread 資訊 |
| `GET` | `/threads/{thread_id}/state` | 取得 thread 完整 state（含所有欄位，不受 output schema 過濾） |
| `DELETE` | `/threads/{thread_id}` | 刪除 thread |

### Runs

| Method | Path | 說明 |
|--------|------|------|
| `POST` | `/threads/{thread_id}/runs` | 非同步建立 run，立即回傳 `{ run_id, status: "pending" }` |
| `POST` | `/threads/{thread_id}/runs/wait` | 同步建立 run，阻塞至完成，回傳 **output schema** |
| `POST` | `/threads/{thread_id}/runs/stream` | 建立 run 並以 SSE 串流更新 |
| `GET` | `/threads/{thread_id}/runs/{run_id}` | 取得 run 狀態 `{ status: "pending"\|"running"\|"success"\|"error" }` |
| `DELETE` | `/threads/{thread_id}/runs/{run_id}` | 取消 run |

> `/runs/wait` 為最常用的端點：建立並等待完成，直接回傳 output schema 結果。

### Assistants

| Method | Path | 說明 |
|--------|------|------|
| `GET` | `/assistants` | 列出所有 assistants |
| `GET` | `/assistants/{assistant_id}` | 取得 assistant 詳情 |
| `GET` | `/assistants/{assistant_id}/schemas` | 取得 input / output / state schema |
| `GET` | `/assistants/{assistant_id}/graph` | 取得 graph 節點/邊結構 |

### 系統

| Method | Path | 說明 |
|--------|------|------|
| `GET` | `/ok` | Health check，回傳 `{ ok: true }` |
| `GET` | `/info` | Server 版本資訊 |
| `GET` | `/docs` | Swagger UI |
| `GET` | `/openapi.json` | OpenAPI schema |

---

## craft3d Graph 使用範例

### 最簡流程（推薦）

```
POST /threads          →  { thread_id }
POST /threads/{id}/runs/wait  →  { job_id, glb_url, failure_reason }
```

#### Step 1 — 建立 Thread

```http
POST http://localhost:3600/threads
Content-Type: application/json

{}
```

```json
{ "thread_id": "d4e5f6a7-..." }
```

#### Step 2 — 建立 Run 並等待完成

```http
POST http://localhost:3600/threads/d4e5f6a7-.../runs/wait
Content-Type: application/json

{
  "assistant_id": "craft3d",
  "input": {
    "input": {
      "object_name": "red_cube",
      "object_description": "A shiny red cube with rounded corners"
    }
  }
}
```

> `input` 第一層對應初始 state 的更新，第二層 `input` 對應 `Craft3DState.input`（`ObjectProps`）。

**成功回傳：**
```json
{
  "job_id": "abc123",
  "glb_url": "http://localhost:3601/jobs/abc123/glb",
  "failure_reason": null
}
```

**失敗回傳：**
```json
{
  "job_id": "",
  "glb_url": "",
  "failure_reason": "Render failed after 5 revisions: ..."
}
```

#### Step 3 — 下載 GLB（via craft3d service）

```http
GET http://localhost:3601/jobs/abc123/glb
→ binary GLB (Content-Type: model/gltf-binary)
```

---

### 非同步輪詢流程（適用於需即時取得 task_id 的情況）

```
POST /threads               →  { thread_id }
POST /threads/{id}/runs     →  { run_id }       ← 立即返回
loop: GET /threads/{id}/runs/{run_id}  →  { status }
GET /threads/{id}/state     →  { values: { glb_url, job_id, failure_reason, ... } }
```

> 此流程可在 run 啟動後立即取得 `thread_id` 通知外部（如 AI agent），再繼續等待結果。

---

## Output Schema 說明

`craft3d` graph 定義了 `output=Craft3DOutput`，只有以下欄位會透過 `/runs/wait` 和 stream 回傳：

| 欄位 | 類型 | 說明 |
|------|------|------|
| `job_id` | `str` | render service 的 job ID，空字串代表渲染失敗 |
| `glb_url` | `str` | GLB 下載 URL，空字串代表渲染失敗 |
| `failure_reason` | `str \| null` | 失敗原因（最後一次 review comment），成功時為 null |

> `GET /threads/{id}/state` 仍回傳**完整 state**（含 `artifact_history` 等），不受 output schema 影響。

---

## Run Input 格式（craft3d）

| 欄位 | 類型 | 必填 | 說明 | 別名 |
|------|------|------|------|------|
| `object_name` | string | ✅ | 物件識別名稱 | `name` |
| `object_description` | string | | 3D 物件描述 | `description` |
