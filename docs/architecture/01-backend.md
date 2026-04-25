# 3DOG 架構 — 後端（3dog-node-backend）

後端服務，負責 AI 驅動的 3D 物件生成管線。以 Docker 容器化部署（多服務共存於同一容器）。

---

## craft3d（Node.js / Hono，port 3601）

將 Three.js TypeScript 程式碼渲染成 GLB 模型與 PNG 快照。

### 渲染流程

1. 接收 Three.js TypeScript 程式碼
2. TypeScript 轉譯為 JavaScript
3. Playwright（無頭 Chromium）執行程式碼，呼叫 `__export(object3D)`
4. GLTFExporter 將 Three.js 物件序列化為 GLB
5. 額外生成 16 視角 PNG 快照網格（用於 AI 審查）

### 主要端點

| 端點 | 說明 |
|------|------|
| `POST /render` | 同步渲染，一次回傳 GLB + PNG（base64） |
| `POST /jobs` | 非同步建立渲染任務 |
| `GET /jobs/:id/wait` | 長輪詢等待任務完成 |
| `GET /jobs/:id/glb` | 下載 GLB |
| `GET /jobs/:id/snapshot` | 下載 PNG 快照 |
| `GET /healthz` | 健康檢查 |

儲存層使用本機 SQLite（BetterSqlite3），記錄渲染任務狀態與產物（程式碼、GLB、PNG）。

---

## agents（Python / LangGraph，port 3600）

包含兩個 LangGraph graph：`orchestrator`（會話管理）與 `craft3d`（3D 物件生成）。

LangGraph Studio UI 可在開發時透過 `http://localhost:2024` 存取。

---

### orchestrator graph

**職責：** Unity Realtime API 會話的 context 管理器。每次 Realtime API 接通時，Unity 建立一個 orchestrator thread，作為整個會話的持久化事件日誌與工具路由器。

#### Graph 結構

```
START → record_event → [event_router]
                            ├─ tool_call "create_3d_object" → invoke_craft3d → [_after_craft3d]
                            │                                                       ├─ animation_enabled + craft3d 成功 → invoke_animation_agent → END
                            │                                                       └─ 否則 ─────────────────────────────────────────────────── END
                            └─ 其他事件（transcript, transcript_done）──────────────────────────────────────────────────────────────────── END
```

#### 節點職責

| 節點 | 職責 |
|------|------|
| `record_event` | 將 `current_event` 追加到持久化 `events` 日誌 |
| `invoke_craft3d` | 以 sub-agent 方式呼叫 craft3d graph；記錄 `tool_result` 事件；設定 `subagent_result` |
| `invoke_animation_agent` | 從 tool server 取得 animation bundle，呼叫 animation_agent graph；設定 `animation_result`；將 `csharp_url` 寫回 `subagent_result` |

#### State（`OrchestratorState`）

| 欄位 | 說明 |
|------|------|
| `events` | Annotated[list, append] — 跨所有 run 累積的事件日誌 |
| `current_event` | 當前 run 的輸入事件（每次 run 覆寫） |
| `subagent_result` | 最後一次工具呼叫的 sub-agent 結果（`job_id`, `glb_url`, `csharp_url`, `failure_reason`） |
| `animation_result` | Animation Agent 的詳細結果（`job_id`, `csharp_ready`, `csharp_url`, `planner_class_name`, `failure_reason`）；debug/audit 用，Unity 仍從 `subagent_result.csharp_url` 取值 |

#### 收集的事件類型

| 類型 | 來源 |
|------|------|
| `tool_call` | SpaceWizard 收到 AI function call |
| `tool_result` | orchestrator 完成 craft3d 呼叫後自動記錄 |
| `transcript` | 使用者語音轉錄完成（Whisper） |
| `transcript_done` | AI 回應轉錄完成 |

> Delta 事件（音訊、逐字轉錄 delta）**不記錄**。

**Output Schema（`OrchestratorOutput`）：** Unity 讀取 `GET /threads/{id}/state` 取得 `subagent_result { job_id, glb_url, csharp_url, failure_reason }` 及 `animation_result { job_id, csharp_ready, csharp_url, planner_class_name, failure_reason }`。`csharp_url` 在 Animation Agent 成功後填入；失敗或未啟用時為空字串。

---

### craft3d graph

以迭代循環方式從文字描述生成 3D 物件程式碼。craft/revise 節點使用 Google Gemini，review 節點使用 OpenAI。由 orchestrator 以 sub-agent 方式呼叫，不直接對外服務。

#### Graph 結構

```
START → craft_node → render_node → review_node → review_router
                          ↑                             │
                     revise_node ◄──── (未通過審查) ────┘
                                        (通過 或 達上限) → END
```

#### 節點職責

| 節點 | 職責 |
|------|------|
| `craft_node` | Gemini（gemini-3-flash-preview）生成 Three.js TypeScript 程式碼 |
| `render_node` | 呼叫 craft3d `POST /render`，取得 PNG 快照 + job_id；設定 `glb_url` |
| `review_node` | OpenAI（gpt-5.4-mini）檢視 16 視角快照，判斷是否通過；設定 `failure_reason` |
| `revise_node` | Gemini 根據審查意見修訂程式碼 |

#### Output Schema（`Craft3DOutput`）

| 欄位 | 說明 |
|------|------|
| `job_id` | render service job ID（渲染失敗時為空字串） |
| `glb_url` | GLB 下載 URL（渲染失敗時為空字串） |
| `csharp_url` | C# 動畫腳本下載 URL（csharp agent 開發完成前為空字串） |
| `failure_reason` | 失敗原因；成功時為 null |

> GLB bytes **不存入** LangGraph state。Unity 透過 `glb_url` 直接從 craft3d 下載。

---

## realtime-monitor（Node.js / Hono，port 3681）

瀏覽器端開發工具，提供兩項功能：

### 1. Realtime API 事件監視器

Unity Server 透過 `/unity-ws` 將每個傳送給或接收自 OpenAI Realtime API 的封包轉發至此服務，瀏覽器可即時查看、過濾事件日誌。

### 2. HoloLens Capture Relay（測試專用）

維護與 HoloLens Unity Client 的持久 WebSocket 連線（`/hololens-ws`），供瀏覽器直接觸發拍照測試使用。**正式 AI 對話流程已改用 WebRTC DataChannel，不再使用此服務。**

| 端點 | 說明 |
|------|------|
| `POST /api/capture/request` | 瀏覽器測試介面呼叫 |
| `GET /api/capture/result/:requestId` | 輪詢拍照結果（base64 data URI） |
| `GET /api/capture/status` | 查詢 HoloLens 是否已連線（供瀏覽器測試介面使用） |

瀏覽器 UI 首頁另提供 **HoloLens Capture Tester**，可不透過 Unity Server 直接從瀏覽器觸發拍照並預覽結果，方便 debug。

> **通道隔離**：Capture 模組是獨立的測試功能，其 sys 事件（HoloLens 連線、拍照觸發/完成等）**不寫入任何 Realtime API 的 `conv.log`，也不廣播給 session 瀏覽器**。`mountCaptureRoutes` 的 `broadcast` 參數傳入 `undefined`，僅保留 `broadcastGlobalFn`（用於更新首頁的裝置清單 `hololens_devices`）。Realtime API 事件監視頁（`/ws?conv=<id>`）因此不會出現任何 Capture 相關紀錄。

> **⚠ 單裝置限制（已知問題，影響測試路徑）**
>
> `capture.ts` 使用單一全域變數 `hololensWs: WSContext | null` 追蹤 HoloLens 連線，**一次只支援一台裝置**。正式路徑（WebRTC DataChannel）不受此限制影響，天然支援多台 Client 廣播收集。
>
> 多台 HoloLens 連線時的行為（測試路徑）：
> - 每次新裝置連上 `/hololens-ws`，`hololensWs` 就被覆蓋為最新連線 → **所有拍照命令只會送給「最後連線」的那台**
> - 若前一台（已被覆蓋）斷線，`onClose` 仍會將 `hololensWs` 設為 `null` → 服務誤判「無裝置連線」，回傳 `503`，即使另一台仍在線
