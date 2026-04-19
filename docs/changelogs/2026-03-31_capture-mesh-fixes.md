# Capture 修復 / Mesh 隱藏 / Mesh 伺服器重建 — 變更摘要

**日期**：2026-03-31

---

## 背景

本次修復涵蓋三個獨立問題：

1. **Capture 功能失效**：Server 廣播 `capture_request` 後，10 秒 timeout 先觸發，圖片稍晚才抵達 Server，導致 `CapturePhotoHandler` 視為失敗。
2. **Mesh 污染截圖**：啟用 Spatial Mesh 後，拍照時半透明黑色三角形網格覆蓋畫面，降低 LLM 圖像分析效果。
3. **Mesh 同步狀態不明 / Server 缺乏物理重建**：Server 發送 capability query 後沒有後續 log，無法確認同步是否成功；mesh 傳到 Server 後缺乏 `MeshCollider` 重建，物件會穿透真實表面。

---

## 一、Capture Timeout 修復（Issue 1）

### 根因分析

`CapturePhotoHandler.timeoutSec` 預設 10 秒。然而 HoloLens `PhotoCapture` 初始化流程包含：

- `PhotoCapture.CreateAsync(showHolograms: true)` — 2–4 秒
- `StartPhotoModeAsync(camParams, ...)` — 2–6 秒

若第一次 capture_request 在場景啟動後不久就抵達（`MRCaptureManager.InitPhotoCaptureCoroutine` 尚未完成），`PhotoCaptureCoroutine` 會等待 `_initDone`，加上 `TakePhotoAsync` 本身耗時，總計可超過 10 秒。

結果：Server 已 timeout 並取消訂閱 `onTextMessage`；圖片稍晚送達，`GenAIDataChannelTextInput` 仍能記錄到（"圖片已成功傳輸" log），但 `CapturePhotoHandler` 已看不到。

### 修復內容

| 檔案 | 變更 |
|------|------|
| `CapturePhotoHandler.cs` | `timeoutSec` 預設值 10 → **30**；新增 broadcast 確認 log、timeout 警告（含已等待秒數與已收到/預期數量）、完成 log |
| `GenAICaptureHandler.cs` | `SendResult` 改為先 log 傳送大小（`imageBase64` 字元數與估算 KB），移除在傳送後才印的誤導性 "sent" log；`dataChannel` 為 null 時改為 `LogError` 而非靜默忽略；`OnEnable` 中 null 時印 `LogError` 提示未設 Inspector 引用 |
| `GenAIDataChannel.cs` | `EnsureOpen()` 訊息更清楚：標示是 "channel not initialized" 或 "channel state is X (expected Open). Message dropped." |

---

## 二、Mesh 隱藏拍照（Issue 2）

### 修復內容

`MRCaptureManager` 新增 `DisableSpatialMeshRenderers()` / `RestoreSpatialMeshRenderers()` helpers：

- 找出所有在 **"Spatial Awareness" Layer** 的 `Renderer`，拍照前停用、拍照後還原
- **`MeshCollider` 不受影響**，空間感知（物理碰撞、Raycasting）照常運作
- **UWP 路徑**：停用 renderer 後多等一幀（`yield return null`），確保 MRC pipeline 讀取的是不含 mesh 的 frame；`TakePhotoAsync` 完成後立即還原
- **Editor 路徑**：停用後直接執行 `Camera.Render()`；RenderTexture 讀取完畢後立即還原

| 檔案 | 變更 |
|------|------|
| `MRCaptureManager.cs` (Client) | 新增 `DisableSpatialMeshRenderers` / `RestoreSpatialMeshRenderers`；在 `PhotoCaptureCoroutine` 與 `RenderTextureCaptureCoroutine` 的拍照步驟前後呼叫 |

---

## 三、Mesh 同步 Log 強化 + Server 物理重建（Issue 3）

### 3.1 SpatialDataUploader null-check 警告（Client）

| 檔案 | 變更 |
|------|------|
| `SpatialDataUploader.cs` (Client) | `OnEnable`：`dataChannel` 為 null 時印 `LogError`（原先靜默跳過），提示設定 Inspector 引用 |
| `SpatialDataUploader.cs` (Client) | `HandleCapabilityQuery`：`capabilityDetector` 為 null 時印 `LogWarning`，說明將回報無能力 |

### 3.2 SpatialAuthorityManager 詳細 Log（Server）

| 行為 | 說明 |
|------|------|
| `Start` | 印初始化成功 log；若有既存 peer 則印 "Querying N peers on Start" |
| `HandleTextMessage` | 所有 `spatial_*` 類型訊息均印 "Received '{type}' from '{senderId}'" |
| `QueryCapability` | `SendTextTo` 失敗時印 `LogWarning`（含排查提示） |
| `HandleCapabilityReport` | 反序列化失敗時印警告；回報 false/false 時印詳細提示（MRTK2 設定問題）；選出 authority 時印詳細步驟 |
| `ElectAuthority` | 印 `authority_assign` 與 `sync_request` 是否成功發送 |
| `HandleMeshUpsert` | 反序列化失敗時印警告；成功時印 meshId、頂點/三角形數、position |

### 3.3 SpatialMeshBuilder（Server，新增）

`Assets/Scripts/Spatial/SpatialMeshBuilder.cs`

- 訂閱 `SpatialDataStore.OnMeshUpserted / OnMeshDeleted / OnClientDataCleared / OnAllCleared`
- 每筆 `OnMeshUpserted` 建立（或更新）一個 `SpatialMesh_{meshId}` GameObject：
  - `MeshFilter` + `MeshCollider`（32-bit index format，支援大 mesh）
  - `MeshRenderer`：**預設停用**（純物理）；Inspector 中可開啟 `showDebugMesh` 以視覺化驗證
  - 自動計算 normals 與 bounds
- 所有子 GameObject 掛在此 component 的 transform 下方便管理
- 不改變 `SpatialDataStore`（純消費者）

---

## 四、Scene Setup 說明

### Server（Unity Editor）

1. 在場景中找（或新增）一個持久 GameObject，掛載 **`SpatialMeshBuilder`** 元件
2. `SpatialDataStore` 與 `SpatialAuthorityManager` 已存在；`SpatialMeshBuilder` 在 `Start()` 自動取得 Singleton 引用，無需 Inspector 拖拉

### Client（HoloLens）

確認以下 Inspector 引用均已設定：

| 元件 | 引用欄位 | 說明 |
|------|----------|------|
| `GenAICaptureHandler` | `dataChannel` | 拖入場景中的 `GenAIDataChannel` |
| `SpatialDataUploader` | `dataChannel` | 拖入場景中的 `GenAIDataChannel` |
| `SpatialDataUploader` | `capabilityDetector` | 拖入場景中的 `SpatialCapabilityDetector` |

缺少上述任一引用，元件在 `OnEnable` 時會輸出 `LogError` 提示，方便快速排查。

---

## 五、受影響檔案

### Client（`3dog-rt-unity-client/Assets/Scripts/`）

| 路徑 | 狀態 |
|------|------|
| `GenAI/GenAICaptureHandler.cs` | 修改 |
| `GenAI/MRCaptureManager.cs` | 修改 |
| `GenAIDataChannel.cs` | 修改 |
| `Spatial/SpatialDataUploader.cs` | 修改 |

### Server（`3dog-rt-unity-server/Assets/Scripts/`）

| 路徑 | 狀態 |
|------|------|
| `GenAI/CapturePhotoHandler.cs` | 修改 |
| `GenAIDataChannel.cs` | 修改 |
| `Spatial/SpatialAuthorityManager.cs` | 修改 |
| `Spatial/SpatialMeshBuilder.cs` | **新增** |

### 文件

| 路徑 | 狀態 |
|------|------|
| `3dog-node-backend/docs/architecture/02-unity-server.md` | 修改（timeout 10→30；補 SpatialMeshBuilder；修正舊 API 引用） |
| `3dog-node-backend/docs/architecture/03-unity-client.md` | 修改（補 Mesh 隱藏策略說明） |
| `3dog-node-backend/docs/architecture/04-larr.md` | 修改（補 SpatialMeshBuilder 表格項目） |
| `3dog-node-backend/docs/changelogs/2026-03-31_capture-mesh-fixes.md` | **新增**（本文件） |
