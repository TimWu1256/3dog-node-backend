# 3DOG 架構 — Unity Server（3dog-rt-unity-server）

運行在實驗室 PC 上的 Unity 伺服器端應用，是整個場景的 authority。負責：
- 與 OpenAI Realtime API 維持 WebSocket 連線
- 處理語音輸入/輸出（雙向音訊）
- 接收 AI tool call，觸發 3D 物件生成
- 管理已生成物件的場景狀態
- 透過 LARR 將視角串流至 HoloLens

腳本位於 `Assets/Scripts/GenAI/`。

---

## RealtimeAgentBase（抽象基類）

自製的 OpenAI Realtime API WebSocket 客戶端，不依賴 `com.openai.unity` SDK。

### 設計原則

- 使用 server-side VAD（語音活動偵測由 OpenAI 伺服器判斷）
- 客戶端只發送 `input_audio_buffer.append`；不發送 `clear` / `commit`
- 具備自動重連（指數退避，最大 10 秒間隔）
- 訊息佇列（`ConcurrentQueue`）確保連線中斷時不漏發
- 使用 `JsonUtility` 序列化，禁止手動拼接 JSON 字串

### 對外事件

| 事件 | 說明 |
|------|------|
| `OnAudioReceived` | 收到 AI 語音 delta（PCM16 base64） |
| `OnTextChunkReceived` | 收到逐字轉錄 delta |
| `OnTextReceived` | 轉錄完成 |
| `OnToolCallReceived` | 收到 function call（完整參數） |
| `OnFlushAudio` | 需清空音訊緩衝區（新發言開始） |

---

## SpaceWizard（Singleton）

`RealtimeAgentBase` 的具體實作，是場景中 AI 助手的主體。

- API Key 從 `StreamingAssets/OpenaiConfig.txt` 讀取
- System prompt 從 `StreamingAssets/instructions/space-wizard.md` 讀取
- 向 OpenAI 登錄兩個 tool：
  - `create_3d_object`（`object_name`, `object_description`）→ `ObjectGenerationHandler.StartGenerationProcess()`
  - `capture_photo`（無參數）→ `CapturePhotoHandler.StartCapture()`，透過 GenAI WebRTC DataChannel 廣播截圖請求，收集所有 Client 回應後批量注入對話
- 收到 tool call 後透過系統訊息告知 AI 進度

---

## AudioDuplex（Singleton）

雙向音訊管理，解耦硬體與網路層。

- **發送端**：從麥克風錄音，以 PCM16 LE 格式按固定間隔（預設 100ms）發出 `OnAudioPcm16Data` 事件
- **接收端**：接收來自 AI 的 PCM16 base64 音訊，解碼後排入播放佇列
- 支援鍵盤控制：Z 鍵切換、Space 鍵 push-to-talk

SpaceWizard 訂閱 AudioDuplex 事件，雙向橋接到 OpenAI Realtime WebSocket。

---

## ObjectGenerationHandler

負責對接後端 orchestrator API，管理會話 thread 並驅動 3D 物件生成流程。

### 會話初始化（每次連線呼叫一次）

- `BeginOrchestratorSession()` — 由 SpaceWizard.OnSessionReady() 呼叫
  - `POST /threads` → `sessionThreadId`（整個 Realtime 會話共用）

### 工具呼叫流程

1. `POST /threads/{sessionThreadId}/runs`（tool_call 事件）→ `runId`；立即呼叫 `onCreated(runId)` 通知 SpaceWizard
2. Poll `GET /threads/{sessionThreadId}/runs/{runId}` — 等待 orchestrator 完成（內含 craft3d sub-agent）
3. `GET /threads/{sessionThreadId}/state` → `values.subagent_result { job_id, glb_url, csharp_url, failure_reason }`
4. 若 `glb_url` 非空 → 交給 `GLBImporter` 從 URL 匯入場景；否則呼叫 `onError(failure_reason)`
4b. 若 `csharp_url` 非空 → `GET {csharp_url}` 取得 C# 動畫腳本並附加至物件

### 事件記錄（fire-and-forget）

- `RecordEventAsync(type, text)` — 提交 transcript / transcript_done 事件，不等待結果

---

## CapturePhotoHandler

負責透過 GenAI WebRTC DataChannel 驅動多 Client 截圖流程。

### 流程

1. 呼叫 `GenAIDataChannelManager.Broadcast(json)`，廣播 `capture_request`（`requestId`, `prompt`）給所有 DataChannel 狀態為 Open 的 Client
2. `Broadcast()` 回傳實際送達的 peer ID 列表，作為本次請求的 expected-responder set（`HashSet<string> expectedPeers`）
   - 這修正了舊設計中 `ConnectedPeerCount` 與 `Broadcast` 之間的 race condition
3. 訂閱 `GenAIDataChannelManager.OnTextReceived`，收集各 Client 的 `capture_result` / `capture_error`
4. 訂閱 `GenAIDataChannelManager.OnPeerRemoved`：若 Client 在截圖過程中斷線，立即記為 `capture_error`，避免等到 timeout
5. 收到非 `expectedPeers` 中的 sender 回應時忽略（防止意外重複）
6. 等待至所有 Client 回應，或 **timeout** 到期（預設 10s）
7. 呼叫 `onAllComplete(List<CaptureClientResult>)`，由 `SpaceWizard` 對每筆成功截圖呼叫 `SendConversationImage()`

---

## GenAIDataChannel / GenAIDataChannelManager

### Wire format

訊息為純 UTF-8 JSON 字串，**不帶任何 byte marker prefix**。片段重組以 `{`（0x7B）作為新訊息的起始標記，以 `}` 作為結束判斷。

> **舊設計移除**：先前版本有 1-byte type marker（0x00 = text, 0x01 = binary），現已廢除。Binary message support（`SendBytes`、`BroadcastBytes`、`OnBytesReceived`）已移除。

### API（GenAIDataChannelManager 對外介面）

| 方法 / 事件 | 說明 |
|-------------|------|
| `Broadcast(json)` | 廣播 JSON 給所有 Open peers，**回傳** `List<string>` 實際送達的 peer ID |
| `SendTo(peerId, json)` | 單播給指定 peer |
| `OnTextReceived` | `(senderId, json)` — 收到任一 peer 訊息 |
| `OnPeerAdded` / `OnPeerRemoved` | peer 上下線事件 |
| `ConnectedPeerCount` | 目前 DataChannel 狀態為 Open 的 peer 數 |

### Send queuing

訊息在 DataChannel 尚未 Open 時會進入佇列；DataChannel 進入 Open 狀態（訂閱 `StateChanged` 事件）時自動 flush。

---

## GLBImporter / GLBManager

- `GLBImporter`：使用 `GltfFast`（`com.unity.cloud.gltfast`）將 GLB URL 直接匯入為 Unity GameObject
- `GLBManager`：管理場景中已生成的物件集合

---

## 開發中 / WIP

| 腳本 | 狀態 | 說明 |
|------|------|------|
| `ToolRouter.cs` | WIP（全部 comment out） | 通用 tool call 路由器，計畫取代 SpaceWizard 內嵌的 tool 處理邏輯 |
| `TextObjectGenerator.cs` | WIP | 封裝 `ObjectGenerationHandler`，提供更簡潔的文字轉 3D 介面；也支援 Inspector 內直接測試 |

---

## UI

`UI/TranscriptUI.cs`：顯示 Realtime API 的即時轉錄文字。
