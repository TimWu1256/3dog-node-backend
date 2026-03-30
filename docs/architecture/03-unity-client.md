# 3DOG 架構 — Unity Client（3dog-rt-unity-client）

運行在 HoloLens 上的 Unity 客戶端，透過 LARR（Local Assisted Remote Rendering）接收 Unity Server 的視訊串流。

腳本位於 `Packages/LARR-Client/Runtime/Scripts/`，主要處理：
- 接收並播放來自 Server 的視訊串流
- 同步物件位置與變換
- 回傳 HoloLens 使用者的頭部位置／視角資訊

---

## MR 拍照功能

腳本位於 `Assets/Scripts/GenAI/`。

### 元件

| 腳本 | 職責 |
|------|------|
| `GenAICaptureHandler.cs` | **正式路徑**：接收 GenAI DataChannel（ID 7）上的 `capture_request`，委派給 `MRCaptureManager`；回傳 `capture_result` 或 `capture_error` |
| `MRCaptureManager.cs` | 執行實際拍照邏輯（見下方） |
| `CaptureRelayConnection.cs` | **測試路徑（僅 realtime-monitor 使用）**：維護與 realtime-monitor `/hololens-ws` 的持久 WebSocket 連線；不參與正式 AI 對話流程 |

### MRCaptureManager 平台策略

| 平台 | 方法 | 說明 |
|------|------|------|
| UWP（HoloLens） | `PhotoCapture.CreateAsync(showHolograms: true)` | 使用 HoloLens 原生 MRC（Mixed Reality Capture）管線，正確合成真實世界攝影機畫面與全息影像。**這是 HoloLens 上唯一可靠的方法**。 |
| Editor / 其他平台 | 顯式 `Camera.Render()` → RenderTexture | arCamera 先渲染背景，virtualCamera 以 Depth-only clear 疊加虛擬物件。使用 `Camera.Render()` 而非 `WaitForEndOfFrame()`，避免 XR 模式下相機不寫入自訂 RenderTexture 的問題。 |

> **注意**：舊版使用 `WaitForEndOfFrame()` 方式在 HoloLens XR 模式下會產生全黑影像，原因是 XR runtime 直接控制相機 frame 提交，不經過 Unity 標準相機渲染管線，導致 RenderTexture 保持空白（全黑）。

---

## 正式拍照資料流（WebRTC DataChannel）

```
SpaceWizard（AI function call: capture_photo）
  ↓
CapturePhotoHandler（Unity Server）
  ├─ 讀取 ConnectedPeerCount → N 台 HoloLens
  ├─ 廣播 capture_request { requestId, prompt } via GenAI DataChannel (ID 7)
  └─ 等待收集所有回應（timeout 10s）
        │
        ▼（每台 HoloLens 獨立執行）
  GenAICaptureHandler（HoloLens Client）
    ↓
  MRCaptureManager（PhotoCapture API / Camera.Render()）
    ├─ 成功 → capture_result { requestId, imageBase64 } via DataChannel
    └─ 失敗 → capture_error { requestId, reason } via DataChannel
        │
        ▼（Server 收集完畢）
  SpaceWizard.SendConversationImage()（每張成功截圖各一次）
  → 注入 OpenAI Realtime API 對話，觸發 AI 回應
```

---

## 測試拍照資料流（realtime-monitor，僅供開發測試）

```
瀏覽器 HoloLens Capture Tester
  ↓ HTTP POST /api/capture/request（requestId）
realtime-monitor Relay（port 3681）
  ↓ WebSocket: capture_command { requestId, prompt }
HoloLens CaptureRelayConnection
  ↓
MRCaptureManager（PhotoCapture API / Camera.Render()）
  ↓ WebSocket: capture_result { requestId, imageBase64 }
realtime-monitor Relay
  ↑ HTTP GET /api/capture/result/:requestId（瀏覽器輪詢）
瀏覽器預覽截圖結果
```

> **通道隔離**：正式路徑（GenAI DataChannel）與測試路徑（realtime-monitor WebSocket）完全獨立，互不影響。兩條路徑共用 `MRCaptureManager` 進行底層截圖，由 `requestId` 區分不同的截圖請求。
