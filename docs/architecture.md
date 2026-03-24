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
│   │  (Realtime   │                │  (待重構，目前呼叫        │  │
│   │   Agent)     │                │   localhost:3600)        │  │
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
           │ WebSocket (wss://api.openai.com)     │ HTTP POST
           ▼                                     ▼
   OpenAI Realtime API              ┌─────────────────────────┐
   (gpt-4o-realtime)                │   3dog-node-backend     │
                                    │                         │
                                    │  agents  :3600 (Python) │
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

使用 Google Gemini 以迭代循環方式從文字描述生成 3D 物件程式碼。

**Graph 結構（craft3d graph）：**
```
START → craft_node → render_node → review_node → review_router
                          ↑                             │
                     revise_node ◄──── (未通過審查) ────┘
                                        (通過 或 達 5 次上限) → END
```

| 節點 | 職責 |
|------|------|
| `craft_node` | Gemini 生成 Three.js TypeScript 程式碼 |
| `render_node` | 呼叫 craft3d `POST /render`，取得 PNG 快照 + job_id；設定 `glb_url` |
| `review_node` | Gemini 檢視 16 視角快照，判斷是否通過；設定 `failure_reason` |
| `revise_node` | Gemini 根據審查意見修訂程式碼 |

**Output Schema（`Craft3DOutput`）：** `/runs/wait` 與 stream 端點只回傳以下欄位：

| 欄位 | 說明 |
|------|------|
| `job_id` | render service job ID（渲染失敗時為空字串） |
| `glb_url` | GLB 下載 URL（渲染失敗時為空字串） |
| `failure_reason` | 失敗原因；成功時為 null |

> GLB bytes **不存入** LangGraph state。Unity 透過 `glb_url` 直接從 craft3d 下載。

LangGraph Studio UI 可在開發時透過 `http://localhost:2024` 存取。

#### realtime-demo（Node.js，port 3681）

實驗性開發工具，示範 OpenAI Realtime API 的 Node.js relay 用法。不屬於正式部署架構。

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
- 向 OpenAI 登錄唯一 tool：`create_3d_object`（`object_name`, `object_description`）
- 收到 tool call 後呼叫 `ObjectGenerationHandler.StartGenerationProcess()`，並透過系統訊息告知 AI 生成進度

#### AudioDuplex（Singleton）

雙向音訊管理，解耦硬體與網路層。

- **發送端**：從麥克風錄音，以 PCM16 LE 格式按固定間隔（預設 100ms）發出 `OnAudioPcm16Data` 事件
- **接收端**：接收來自 AI 的 PCM16 base64 音訊，解碼後排入播放佇列
- 支援鍵盤控制：Z 鍵切換、Space 鍵 push-to-talk

SpaceWizard 訂閱 AudioDuplex 事件，雙向橋接到 OpenAI Realtime WebSocket。

#### ObjectGenerationHandler

負責對接後端 API，驅動 3D 物件生成流程。

**流程：**
1. `POST http://localhost:3600/threads` — 建立 LangGraph thread，取得 `thread_id`；立即呼叫 `onCreated(threadId)` 通知 SpaceWizard
2. `POST http://localhost:3600/threads/{thread_id}/runs/wait` — 阻塞至 graph 完成，回傳 `Craft3DOutput { job_id, glb_url, failure_reason }`
3. 若 `glb_url` 非空 → 交給 `GLBImporter` 從 URL 匯入場景；否則呼叫 `onError(failure_reason)`

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

---

### 4. 基礎設施（請勿修改）

#### node-dss（port 3000）

WebRTC 信號伺服器（Dead Simple Signalling），提供 FIFO 訊息佇列給 WebRTC P2P 連線建立使用。LARR Server 與 LARR Client 透過此服務交換 SDP offer/answer 與 ICE candidates。

#### WebRTC-mod

針對 LARR 系統的 Unity WebRTC 套件客製化模組，以 PowerShell 腳本覆蓋 Unity 生成的 WebRTC 原生檔案。

---

## 通訊協定與端口

| 服務 | 端口 | 協定 | 說明 |
|------|------|------|------|
| agents（LangGraph） | 3600 | HTTP/REST | 3D 生成 AI 管線入口（`/threads`, `/runs`） |
| craft3d | 3601 | HTTP/REST | Three.js → GLB 渲染 |
| realtime-demo | 3681 | HTTP/WebSocket | 開發用 Realtime 範例 |
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
使用者說話
  → AudioDuplex 擷取麥克風 PCM16
  → SpaceWizard.SendAudio() → OpenAI Realtime WebSocket
  → OpenAI server_vad 偵測發言結束，自動 commit
  → OpenAI 回應（語音 + tool call）
  → AudioDuplex 播放 AI 語音
  → SpaceWizard.HandleToolCall("create_3d_object")
  → ObjectGenerationHandler.StartGenerationProcess()
  → POST /threads（建立 thread）
  → onCreated(threadId) → SpaceWizard 告知 AI「生成中，請稍候」
  → POST /threads/{id}/runs/wait（阻塞至完成，回傳 Craft3DOutput）
  → 完成後 GLBImporter.ImportGLBToScene(glb_url)
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
