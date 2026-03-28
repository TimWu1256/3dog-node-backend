# 3DOG 系統架構

## 系統概覽

3DOG 是一套 **LLM 驅動的混合現實體驗平台**，核心功能包含：
- 語音對話（OpenAI Realtime API，audio-to-audio）
- AI 生成 3D 物件（文字描述 → GLB 模型 → 匯入 Unity 場景）
- 遠端渲染串流至 HoloLens

系統分為三個開發範疇：**後端**、**Unity Server**、**Unity Client**。

## 專案倉庫

| 倉庫 | 說明 |
|------|------|
| `3dog/3dog-node-backend` | 後端服務（AI 管線、渲染服務） |
| `3dog/3dog-rt-unity-server` | Unity 伺服器端（PC，場景 authority） |
| `3dog/3dog-rt-unity-client` | Unity 客戶端（HoloLens） |
| `3dog/node-dss` | WebRTC 信號伺服器 |
| `3dog/WebRTC-mod` | Unity WebRTC 客製化模組 |

**技術亮點：** LLM-based Multi-Agent Systems、Realtime AI（audio-to-audio）、LLM-driven 3D object generation（text-to-3d）

---

## 架構圖

```
┌─────────────────────────────────────────────────────────────────┐
│                        HoloLens                                 │
│                  3dog-rt-unity-client                           │
│              LARR Client (WebRTC P2P)                           │
└──────────────────────┬──────────────────────────────────────────┘
                       │ 視訊串流 + 物件同步 (LARR / WebRTC)
                       │ WebRTC 信號交換 → node-dss (:3000)
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│                   PC（伺服器端）                                 │
│                 3dog-rt-unity-server                            │
│                                                                 │
│   ┌──────────────┐   tool call    ┌─────────────────────────┐  │
│   │  SpaceWizard │ ─────────────► │ ObjectGenerationHandler │  │
│   │  (Realtime   │  transcript    │  (路由至 orchestrator)   │  │
│   │   Agent)     │ ◄─────────────┤                          │  │
│   └──────┬───────┘                └────────────┬────────────┘  │
│          │                                     │               │
│   ┌──────▼───────┐                    ┌────────▼────────────┐  │
│   │  AudioDuplex │                    │  GLBImporter /      │  │
│   │  (麥克風 +   │                    │  GLBManager         │  │
│   │   揚聲器)    │                    │  (匯入場景)          │  │
│   └──────────────┘                    └─────────────────────┘  │
│          │                                     │               │
└──────────┼─────────────────────────────────────┼───────────────┘
           │                                     │
           │ WebSocket (wss://api.openai.com)     │ HTTP POST/GET
           ▼                                     ▼
   OpenAI Realtime API              ┌─────────────────────────┐
   (gpt-4o-realtime)                │   3dog-node-backend     │
                                    │                         │
                                    │  agents  :3600 (Python) │
                                    │  ├─ orchestrator graph  │
                                    │  └─ craft3d graph       │
                                    │  craft3d :3601 (Node.js)│
                                    └─────────────────────────┘
```

---

## 子系統說明

### 1. 3dog-node-backend

後端服務，負責 AI 驅動的 3D 物件生成管線。以 Docker 容器化部署（多服務共存於同一容器）。

#### craft3d（Node.js / Hono，port 3601）

將 Three.js TypeScript 程式碼渲染成 GLB 模型與 PNG 快照。

**渲染流程：**
1. 接收 Three.js TypeScript 程式碼
2. TypeScript 轉譯為 JavaScript
3. Playwright（無頭 Chromium）執行程式碼，呼叫 `__export(object3D)`
4. GLTFExporter 將 Three.js 物件序列化為 GLB
5. 額外生成 16 視角 PNG 快照網格（用於 AI 審查）

**主要端點：**
| 端點 | 說明 |
|------|------|
| `POST /render` | 同步渲染，一次回傳 GLB + PNG（base64） |
| `POST /jobs` | 非同步建立渲染任務 |
| `GET /jobs/:id/wait` | 長輪詢等待任務完成 |
| `GET /jobs/:id/glb` | 下載 GLB |
| `GET /jobs/:id/snapshot` | 下載 PNG 快照 |
| `GET /healthz` | 健康檢查 |

儲存層使用本機 SQLite（BetterSqlite3），記錄渲染任務狀態與產物（程式碼、GLB、PNG）。

#### agents（Python / LangGraph，port 3600）

包含兩個 LangGraph graph：`orchestrator`（會話管理）與 `craft3d`（3D 物件生成）。

---

##### orchestrator graph

**職責：** Unity Realtime API 會話的 context 管理器。每次 Realtime API 接通時，Unity 建立一個 orchestrator thread，作為整個會話的持久化事件日誌與工具路由器。

**Graph 結構：**
```
START → record_event → [event_router]
                            ├─ tool_call "create_3d_object" → invoke_craft3d (sub-agent) → END
                            └─ 其他事件（transcript, transcript_done）──────────────────── END
```

| 節點 | 職責 |
|------|------|
| `record_event` | 將 `current_event` 追加到持久化 `events` 日誌 |
| `invoke_craft3d` | 以 sub-agent 方式呼叫 craft3d graph；記錄 `tool_result` 事件；設定 `subagent_result` |

**State（`OrchestratorState`）：**

| 欄位 | 說明 |
|------|------|
| `events` | Annotated[list, append] — 跨所有 run 累積的事件日誌 |
| `current_event` | 當前 run 的輸入事件（每次 run 覆寫） |
| `subagent_result` | 最後一次工具呼叫的 sub-agent 結果（`job_id`, `glb_url`, `failure_reason`） |

**收集的事件類型：**

| 類型 | 來源 |
|------|------|
| `tool_call` | SpaceWizard 收到 AI function call |
| `tool_result` | orchestrator 完成 craft3d 呼叫後自動記錄 |
| `transcript` | 使用者語音轉錄完成（Whisper） |
| `transcript_done` | AI 回應轉錄完成 |

> Delta 事件（音訊、逐字轉錄 delta）**不記錄**。

**Output Schema（`OrchestratorOutput`）：** Unity 讀取 `GET /threads/{id}/state` 取得 `subagent_result`。

---

##### craft3d graph

使用 Google Gemini 以迭代循環方式從文字描述生成 3D 物件程式碼。由 orchestrator 以 sub-agent 方式呼叫，不直接對外服務。

**Graph 結構：**
```
START → craft_node → render_node → review_node → review_router
                          ↑                             │
                     revise_node ◄──── (未通過審查) ────┘
                                        (通過 或 達上限) → END
```

| 節點 | 職責 |
|------|------|
| `craft_node` | Gemini 生成 Three.js TypeScript 程式碼 |
| `render_node` | 呼叫 craft3d `POST /render`，取得 PNG 快照 + job_id；設定 `glb_url` |
| `review_node` | Gemini 檢視 16 視角快照，判斷是否通過；設定 `failure_reason` |
| `revise_node` | Gemini 根據審查意見修訂程式碼 |

**Output Schema（`Craft3DOutput`）：**

| 欄位 | 說明 |
|------|------|
| `job_id` | render service job ID（渲染失敗時為空字串） |
| `glb_url` | GLB 下載 URL（渲染失敗時為空字串） |
| `failure_reason` | 失敗原因；成功時為 null |

> GLB bytes **不存入** LangGraph state。Unity 透過 `glb_url` 直接從 craft3d 下載。

LangGraph Studio UI 可在開發時透過 `http://localhost:2024` 存取。

#### realtime-monitor（Node.js / Hono，port 3681）

瀏覽器端開發工具，提供兩項功能：

1. **Realtime API 事件監視器**：Unity Server 透過 `/unity-ws` 將每個傳送給或接收自 OpenAI Realtime API 的封包轉發至此服務，瀏覽器可即時查看、過濾事件日誌。

2. **HoloLens Capture Relay**：維護與 HoloLens Unity Client 的持久 WebSocket 連線（`/hololens-ws`），支援：
   - `POST /api/capture/request` — Unity Server 呼叫以觸發 HoloLens 拍照
   - `GET /api/capture/result/:requestId` — 輪詢拍照結果（base64 data URI）
   - `GET /api/capture/status` — 查詢 HoloLens 是否已連線（供瀏覽器測試介面使用）

瀏覽器 UI 首頁另提供 **HoloLens Capture Tester**，可不透過 Unity Server 直接從瀏覽器觸發拍照並預覽結果，方便 debug。

> **⚠ 單裝置限制（已知問題）**
>
> `capture.ts` 使用單一全域變數 `hololensWs: WSContext | null` 追蹤 HoloLens 連線，**一次只支援一台裝置**。
>
> 多台 HoloLens 連線時的行為：
> - 每次新裝置連上 `/hololens-ws`，`hololensWs` 就被覆蓋為最新連線 → **所有拍照命令只會送給「最後連線」的那台**
> - 若前一台（已被覆蓋）斷線，`onClose` 仍會將 `hololensWs` 設為 `null` → 服務誤判「無裝置連線」，回傳 `503`，即使另一台仍在線
>
> 若需支援多台，需改為 `Map<clientId, WSContext>` 並在請求中指定目標裝置。

---

### 2. 3dog-rt-unity-server

運行在實驗室 PC 上的 Unity 伺服器端應用，是整個場景的 authority。負責：
- 與 OpenAI Realtime API 維持 WebSocket 連線
- 處理語音輸入/輸出（雙向音訊）
- 接收 AI tool call，觸發 3D 物件生成
- 管理已生成物件的場景狀態
- 透過 LARR 將視角串流至 HoloLens

腳本位於 `Assets/Scripts/GenAI/`。

#### RealtimeAgentBase（抽象基類）

自製的 OpenAI Realtime API WebSocket 客戶端，不依賴 `com.openai.unity` SDK。

**設計原則：**
- 使用 server-side VAD（語音活動偵測由 OpenAI 伺服器判斷）
- 客戶端只發送 `input_audio_buffer.append`；不發送 `clear` / `commit`
- 具備自動重連（指數退避，最大 10 秒間隔）
- 訊息佇列（`ConcurrentQueue`）確保連線中斷時不漏發
- 使用 `JsonUtility` 序列化，禁止手動拼接 JSON 字串

**對外事件：**
| 事件 | 說明 |
|------|------|
| `OnAudioReceived` | 收到 AI 語音 delta（PCM16 base64） |
| `OnTextChunkReceived` | 收到逐字轉錄 delta |
| `OnTextReceived` | 轉錄完成 |
| `OnToolCallReceived` | 收到 function call（完整參數） |
| `OnFlushAudio` | 需清空音訊緩衝區（新發言開始） |

#### SpaceWizard（Singleton）

`RealtimeAgentBase` 的具體實作，是場景中 AI 助手的主體。

- API Key 從 `StreamingAssets/OpenaiConfig.txt` 讀取
- System prompt 從 `StreamingAssets/instructions/space-wizard.md` 讀取
- 向 OpenAI 登錄兩個 tool：
  - `create_3d_object`（`object_name`, `object_description`）→ `ObjectGenerationHandler.StartGenerationProcess()`
  - `capture_photo`（`prompt?`）→ `CapturePhotoHandler.StartCapture()`，取得 HoloLens MR 照片後注入對話
- 收到 tool call 後透過系統訊息告知 AI 進度

#### AudioDuplex（Singleton）

雙向音訊管理，解耦硬體與網路層。

- **發送端**：從麥克風錄音，以 PCM16 LE 格式按固定間隔（預設 100ms）發出 `OnAudioPcm16Data` 事件
- **接收端**：接收來自 AI 的 PCM16 base64 音訊，解碼後排入播放佇列
- 支援鍵盤控制：Z 鍵切換、Space 鍵 push-to-talk

SpaceWizard 訂閱 AudioDuplex 事件，雙向橋接到 OpenAI Realtime WebSocket。

#### ObjectGenerationHandler

負責對接後端 orchestrator API，管理會話 thread 並驅動 3D 物件生成流程。

**會話初始化（每次連線呼叫一次）：**
- `BeginOrchestratorSession()` — 由 SpaceWizard.OnSessionReady() 呼叫
  - `POST /threads` → `sessionThreadId`（整個 Realtime 會話共用）

**工具呼叫流程：**
1. `POST /threads/{sessionThreadId}/runs`（tool_call 事件）→ `runId`；立即呼叫 `onCreated(runId)` 通知 SpaceWizard
2. Poll `GET /threads/{sessionThreadId}/runs/{runId}` — 等待 orchestrator 完成（內含 craft3d sub-agent）
3. `GET /threads/{sessionThreadId}/state` → `values.subagent_result { job_id, glb_url, failure_reason }`
4. 若 `glb_url` 非空 → 交給 `GLBImporter` 從 URL 匯入場景；否則呼叫 `onError(failure_reason)`

**事件記錄（fire-and-forget）：**
- `RecordEventAsync(type, text)` — 提交 transcript / transcript_done 事件，不等待結果

#### GLBImporter / GLBManager

- `GLBImporter`：使用 `GltfFast`（`com.unity.cloud.gltfast`）將 GLB URL 直接匯入為 Unity GameObject
- `GLBManager`：管理場景中已生成的物件集合

#### 開發中 / WIP

| 腳本 | 狀態 | 說明 |
|------|------|------|
| `ToolRouter.cs` | WIP（全部 comment out） | 通用 tool call 路由器，計畫取代 SpaceWizard 內嵌的 tool 處理邏輯 |
| `TextObjectGenerator.cs` | WIP | 封裝 `ObjectGenerationHandler`，提供更簡潔的文字轉 3D 介面；也支援 Inspector 內直接測試 |

#### UI

`UI/TranscriptUI.cs`：顯示 Realtime API 的即時轉錄文字。

---

### 3. 3dog-rt-unity-client

運行在 HoloLens 上的 Unity 客戶端，透過 LARR（Local Assisted Remote Rendering）接收 Unity Server 的視訊串流。

腳本位於 `Packages/LARR-Client/Runtime/Scripts/`，主要處理：
- 接收並播放來自 Server 的視訊串流
- 同步物件位置與變換
- 回傳 HoloLens 使用者的頭部位置／視角資訊

#### MR 拍照功能（Capture Relay Client）

腳本位於 `Assets/Scripts/GenAI/`。

**元件：**

| 腳本 | 職責 |
|------|------|
| `CaptureRelayConnection.cs` | 維護與 realtime-monitor `/hololens-ws` 的持久 WebSocket 連線；接收 `capture_command`，委派給 `MRCaptureManager`；回傳 `capture_result` 或 `capture_error` |
| `MRCaptureManager.cs` | 執行實際拍照邏輯（見下方） |

**MRCaptureManager 平台策略：**

| 平台 | 方法 | 說明 |
|------|------|------|
| UWP（HoloLens） | `PhotoCapture.CreateAsync(showHolograms: true)` | 使用 HoloLens 原生 MRC（Mixed Reality Capture）管線，正確合成真實世界攝影機畫面與全息影像。**這是 HoloLens 上唯一可靠的方法**。 |
| Editor / 其他平台 | 顯式 `Camera.Render()` → RenderTexture | arCamera 先渲染背景，virtualCamera 以 Depth-only clear 疊加虛擬物件。使用 `Camera.Render()` 而非 `WaitForEndOfFrame()`，避免 XR 模式下相機不寫入自訂 RenderTexture 的問題。 |

> **注意**：舊版使用 `WaitForEndOfFrame()` 方式在 HoloLens XR 模式下會產生全黑影像，原因是 XR runtime 直接控制相機 frame 提交，不經過 Unity 標準相機渲染管線，導致 RenderTexture 保持空白（全黑）。

**拍照資料流：**

```
SpaceWizard（AI function call: capture_photo）
  ↓ HTTP POST /api/capture/request
realtime-monitor Relay（port 3681）
  ↓ WebSocket: capture_command { requestId, prompt }
HoloLens CaptureRelayConnection
  ↓
MRCaptureManager（PhotoCapture API / Camera.Render()）
  ↓ WebSocket: capture_result { requestId, imageBase64 }
realtime-monitor Relay
  ↑ HTTP GET /api/capture/result/:requestId（Unity Server 輪詢）
CapturePhotoHandler（Unity Server）
  ↓ base64 data URI
SpaceWizard → 注入 OpenAI Realtime API 對話
```

---

---

### 4. LARR（Localization-Assisted Remote Rendering）

LARR 是本系統的視訊串流與物件同步子系統，負責將 Unity Server 端的場景即時渲染結果傳輸至 HoloLens，並在兩端之間同步使用者頭部位姿與物件變換。

#### 系統定位

LARR 以 WebRTC P2P 作為傳輸層，透過多條 DataChannel 分別承載不同語義的資料流：視訊串流（WebRTC media track）、物件位姿同步（JSON）、使用者頭部追蹤（CSV）、ACK 確認與物件凍結指令。信號交換（SDP offer/answer、ICE candidates）透過 `node-dss` (:3000) 完成。

```
HoloLens (LARR-Client)                        PC (LARR-Server)
┌──────────────────────────────┐              ┌──────────────────────────────┐
│  ControlUserPosition         │──Camera──────►  ControlObjectPosition       │
│  SendControlInformation      │──Interact────►  ObjectManager / DBSCAN      │
│                              │◄─PlayerSync──   ControlStreamingCamera      │
│  ControlVideoPlayer          │──PlayerAck───►  (ACK received)              │
│  FreezeVideoPlayer           │◄─ObjectFreeze─  (物件凍結指令)               │
│  StreamingMonitor            │◄─Video Track──  RtManager / RenderTexture   │
└──────────────────────────────┘              └──────────────────────────────┘
              │                                              │
              └──────────── node-dss (:3000) ───────────────┘
                             (WebRTC 信號交換)
```

#### DataChannel 一覽

| Channel | 方向 | 格式 | 用途 | 觸發時機 |
|---------|------|------|------|----------|
| **Camera** | Client → Server | CSV: `posX,posY,posZ,rotX,rotY,rotZ` | 使用者頭部追蹤 | 每幀 |
| **Interact** | 雙向 | JSON: `{objName: {pos, rot, scale}}` | 物件操作同步 | 變換發生時 |
| **PlayerSync** | Server → Client | JSON: `{objectName, Position, Rotation, QuadScale, isActive, timestamp}` | 串流相機同步 | 持續發送／有變化時 |
| **PlayerAck** | Client → Server | 字串: `"200 OK:ObjectName"` | 確認收到同步資料 | 收到 PlayerSync 後 |
| **ObjectFreeze** | Server → Client | JSON: `{objectName, timestamp}` | 暫停視訊播放 | Server 主動觸發 |

#### Server 端核心元件

| 元件 | 說明 |
|------|------|
| `CreatePeer` | 監聽新連線，為每個 Client 建立 PeerConnection 與對應的使用者 Prefab，管理 peer 生命週期 |
| `ControlUserPosition` | 解析 Camera channel 的 CSV 資料，更新 peer 在場景中的位置與朝向 |
| `ControlObjectPosition` | 接收 Interact channel 的 JSON，呼叫 `ObjectManager.ObjectUpdate()` 同步場景物件 |
| `ObjectManager` | 維護所有 `VolumetricObject` 清單；執行 **DBSCAN 密度聚類**（ε = 1m，minPts = 2）將鄰近物件分組 |
| `ControlStreamingCamera` | 針對每位使用者計算專屬串流相機，動態調整 FOV 或正交投影以最佳框住目標物件；序列化 `PlayerSyncData` 送出；等待 ACK 後降低傳輸頻率 |
| `RtManager` | 為每台串流相機建立並分配 RenderTexture，供 WebRTC 視訊編碼使用 |
| `OscMerge` | 偵測相鄰物件（閾值 ~0.45m），將近距物件合併至同一渲染相機以降低資源消耗；透過 Unity Layer 控制各相機的渲染範圍 |
| `OscMonitor` | 同步 ObjectManager 中物件的啟用狀態至各串流相機 |

#### Client 端核心元件

| 元件 | 說明 |
|------|------|
| `ControlUserPosition` | 每幀讀取主相機位姿，序列化為 CSV 送出 Camera channel |
| `SendControlInformation` | 監控子物件變換，偵測到變化時序列化為 JSON 送出 Interact channel；以字典快取避免重複傳送 |
| `ControlVideoPlayer` | 接收 PlayerSync 資料，更新視訊 Quad 的位置與縮放；送出 PlayerAck；以 timestamp 去重避免舊訊息影響 |
| `FreezeVideoPlayer` | 接收 ObjectFreeze 指令，暫停對應物件的視訊播放 |
| `StreamingMonitor` | 監控 WebRTC transceiver 狀態，依 MlineIndex 啟用或停用對應的 Object 播放器 |
| `ReceiveInteract` | 接收 Interact channel 的物件變換更新，反序列化後同步本地場景 |

#### 典型資料流：物件移動後的視角更新

```
[Client] 使用者移動物件
  → SendControlInformation 偵測變換
  → 序列化 JSON → Interact channel → WebRTC
  → [Server] ControlObjectPosition 接收
  → ObjectManager 更新座標 → DBSCAN 重新聚類
  → OscMerge 判斷是否需合併渲染
  → ControlStreamingCamera 重算相機視角
  → RtManager 渲染至 RenderTexture
  → 序列化 PlayerSyncData → PlayerSync channel → WebRTC
  → [Client] ControlVideoPlayer 更新視訊 Quad 位置與縮放
  → 送出 PlayerAck → Server 確認同步完成
```

#### 設計要點

- **變換差異偵測**：Client 與 Server 皆以字典快取上一幀狀態，僅在有變化時才發送，降低不必要的網路負載。
- **DBSCAN 聚類**：Server 自動將空間上鄰近的物件分組，為合併渲染相機提供依據。
- **Timestamp 去重**：Client 丟棄 timestamp 早於已處理訊息的舊封包，避免亂序資料污染畫面。
- **可見性 Hysteresis**：`VolumetricObject` 提供 2 秒緩衝，避免物件在視錐邊緣反覆啟停閃爍。
- **動態相機框取**：`ControlStreamingCamera` 依目標物件包圍盒與使用者距離動態調整 FOV，確保物件始終充滿畫面。
- **多 Client 並行**：每個連線的 Client 擁有獨立的 PeerConnection 與串流相機，互不干擾。

---

### 5. 基礎設施（請勿修改）

#### node-dss（port 3000）

WebRTC 信號伺服器（Dead Simple Signalling），提供 FIFO 訊息佇列給 WebRTC P2P 連線建立使用。LARR Server 與 LARR Client 透過此服務交換 SDP offer/answer 與 ICE candidates。

#### WebRTC-mod

針對 LARR 系統的 Unity WebRTC 套件客製化模組，以 PowerShell 腳本覆蓋 Unity 生成的 WebRTC 原生檔案。

---

## 通訊協定與端口

| 服務 | 端口 | 協定 | 說明 |
|------|------|------|------|
| agents（LangGraph） | 3600 | HTTP/REST | AI 管線入口（orchestrator + craft3d graphs，`/threads`, `/runs`） |
| craft3d | 3601 | HTTP/REST | Three.js → GLB 渲染 |
| realtime-monitor | 3681 | HTTP/WebSocket | Realtime API 事件監視器 + HoloLens capture relay |
| node-dss | 3000 | HTTP/REST | WebRTC 信號交換 |
| OpenAI Realtime API | 443 | WSS | AI 語音對話 |
| LARR | — | WebRTC P2P + OSC | Unity Server ↔ HoloLens |

---

## 環境變數

| 位置 | 變數 | 用途 |
|------|------|------|
| `3dog-node-backend/.env` | `GOOGLE_API_KEY` | agents（Gemini） |
| `3dog-node-backend/.env` | `OPENAI_API_KEY` | realtime-demo |
| `3dog-node-backend/.env` | `RENDER_SERVICE_URL` | craft3d service 基礎 URL（預設 `http://localhost:3601`），用於建構 `glb_url` |
| `3dog-node-backend/.env` | `RENDER_GLB_URL` | agents 呼叫 craft3d render 的完整 URL（預設 `{RENDER_SERVICE_URL}/render`） |
| `StreamingAssets/OpenaiConfig.txt` | API Key | SpaceWizard 讀取 OpenAI key |

---

## 核心資料流

### 語音對話觸發 3D 生成

```
[連線建立]
  Realtime API 接通（SpaceWizard.OnSessionReady）
  → ObjectGenerationHandler.BeginOrchestratorSession()
  → POST /threads → sessionThreadId（整個會話共用）

[使用者說話]
  AudioDuplex 擷取麥克風 PCM16
  → SpaceWizard.SendAudio() → OpenAI Realtime WebSocket
  → OpenAI server_vad 偵測發言結束，自動 commit
  → Whisper 轉錄完成 → conversation.item.input_audio_transcription.completed
    → SpaceWizard 轉發 transcript 事件到 orchestrator（fire-and-forget）

[AI 回應]
  OpenAI 回應（語音 + transcript_done + 可能有 tool call）
  → AudioDuplex 播放 AI 語音
  → response.audio_transcript.done → SpaceWizard 轉發 transcript_done 事件到 orchestrator

[AI 呼叫工具]
  response.function_call_arguments.done → SpaceWizard.HandleToolCall("create_3d_object")
  → ObjectGenerationHandler.StartGenerationProcess(name, desc, callId, ...)
  → POST /threads/{sessionThreadId}/runs（tool_call 事件）→ runId
  → onCreated(runId) → SpaceWizard 告知 AI「生成中，請稍候」

[orchestrator 處理 tool_call run]
  record_event_node: 記錄 tool_call 事件到 events 日誌
  invoke_craft3d_node: 以 sub-agent 呼叫 craft3d graph
    → craft3d 生成、渲染、審查（1-3 輪）
    → 取得 SubagentResult { job_id, glb_url }
  記錄 tool_result 事件到 events 日誌
  run 狀態變為 "success"

[Unity 接收結果]
  Poll GET /threads/{sessionThreadId}/runs/{runId} → status="success"
  GET /threads/{sessionThreadId}/state → values.subagent_result.glb_url
  GLBImporter.ImportGLBToScene(glb_url)
  → GameObject 出現在 Unity 場景
  → LARR 串流更新後的視角至 HoloLens
  → SpaceWizard 告知 AI「生成完成」
```

### HoloLens 視角串流

```
Unity Server（場景渲染）
  → LARR-Server 擷取視訊幀
  → WebRTC P2P（信號透過 node-dss）
  → LARR-Client 接收並顯示
  → HoloLens 使用者看到場景視角
```

---

## 部署

### 本機開發

```bash
# 1. 後端（需先建好 .env）
cd 3dog-node-backend
npm run docker:up          # 啟動 agents(:3600) + craft3d(:3601)
npm run docker:logs        # 查看日誌

# 或個別啟動
cd services/craft3d && npm run dev
cd packages/agents_server && uv run langgraph dev --host 0.0.0.0 --port 3600

# 2. Unity Server
# 開啟 3dog-rt-unity-server 專案，確認 StreamingAssets/OpenaiConfig.txt 存在
# Play Mode 執行 GenAIServer 場景

# 3. node-dss（LARR 依賴）
cd node-dss && npm start    # port 3000
```

### Docker 部署

```bash
cd 3dog-node-backend
npm run docker:ghcr:up:pull   # 拉取最新映像並啟動
```

映像同時包含 agents（Python 3.13）與 craft3d（Node.js 24）兩個服務。
