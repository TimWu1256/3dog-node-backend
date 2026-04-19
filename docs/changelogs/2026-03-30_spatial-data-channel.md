# 空間資料傳輸系統 — 變更摘要

**日期**：2026-03-30

---

## 背景

為了讓 Unity Server 能取得 HoloLens 的現實空間資訊（Scene Understanding Quads 與 Spatial Mesh），在現有 GenAI DataChannel 基礎上新增空間資料傳輸協定、權威 Client 選舉機制，以及相關的 CRUD 資料管理。

---

## 一、GenAI DataChannel 重構

### 1.1 Wire Format — 新增 1-byte 類型標記

所有 DataChannel 幀現在以 1 byte 前綴區分文字與二進位：

| 標記 | 值 | 負載 |
|------|----|------|
| Text | `0x00` | UTF-8 字串 |
| Binary | `0x01` | 原始 bytes |

**動機**：DataChannel 不再僅傳文字，未來可能傳 protobuf 二進位資料。

### 1.2 API 更名

| 舊 API | 新 API |
|--------|--------|
| `Send(string)` | `SendText(string)` / `SendBytes(byte[])` |
| `OnMessageReceived` | `OnTextReceived` / `OnBytesReceived` |
| `Broadcast(string)` | `BroadcastText(string)` / `BroadcastBytes(byte[])` |

### 1.3 新增功能

- **`OnDisabled` 事件**：`GenAIDataChannel` 在 `OnDisable()` 時觸發，供 Manager 主動偵測斷線。
- **`OnPeerAdded` / `OnPeerRemoved` 事件**：`GenAIDataChannelManager` 提供 peer 生命週期事件，取代原有的 lazy cleanup。
- **定向發送**：`SendTextTo(peerId, message)` / `SendBytesTo(peerId, data)` — 向指定 peer 發送訊息。
- **Peer 查詢**：`GetConnectedPeerIds()` — 取得所有已連線 peer ID。

### 1.4 移除內容日誌

舊版的 `Log($"Sent: {message}")` 和 `Log($"Received: {message}")` 已移除，因為二進位資料無法以文字打印。Channel 生命週期日誌（初始化、就緒）保留。

### 1.5 受影響檔案

| 檔案 | 專案 | 變更 |
|------|------|------|
| `GenAIDataChannel.cs` | Client + Server | 重構 Send/Receive、新增 framing、新增事件 |
| `GenAIDataChannelManager.cs` | Server | 重構 Broadcast/Register、新增定向發送、peer 事件 |
| `GenAIDataChannelTextInput.cs` | Client + Server | `Send` → `SendText`、`OnMessageReceived` → `OnTextReceived` |
| `GenAICaptureHandler.cs` | Client | `Send` → `SendText`、`OnMessageReceived` → `OnTextReceived` |
| `CapturePhotoHandler.cs` | Server | `Broadcast` → `BroadcastText`、`OnMessageReceived` → `OnTextReceived` |

---

## 二、空間資料傳輸協定

### 2.1 新增訊息類型

全部定義於 `GenAIDataChannelProtocol.cs`（client + server 各一份，內容相同）。

**能力探測：**
- `spatial_capability_query` — Server → Client，詢問空間能力
- `spatial_capability_report` — Client → Server，回報支援狀況

**權威管理：**
- `spatial_authority_assign` — Server → Client，指定權威
- `spatial_authority_revoke` — Server → Client，撤銷權威
- `spatial_sync_request` — Server → Client，要求全量同步
- `spatial_sync_complete` — Client → Server，確認同步完成

**資料傳輸：**
- `spatial_quad_upsert` / `spatial_quad_delete` — Scene Understanding 四邊形 CRUD
- `spatial_mesh_upsert` / `spatial_mesh_delete` — Spatial Mesh 區塊 CRUD

### 2.2 序列化

所有空間訊息經由 `SpatialSerializer` 統一序列化/反序列化。目前底層為 `JsonUtility`（JSON）。未來切換 protobuf 僅需修改 `SpatialSerializer` 一個類別。

訊息 DTO 定義於 `SpatialMessages.cs`，使用 `[Serializable]` 屬性搭配自訂的 `Vec2` / `Vec3` / `Vec4` struct 以避免 `JsonUtility` 對 Unity 原生型別的序列化問題。

---

## 三、Client 端新增元件

### 3.1 `SpatialCapabilityDetector`

- 透過**反射**探測 MRTK2 `CoreServices.SpatialAwarenessSystem` 是否存在
- 檢查 Scene Understanding Observer 與 Spatial Mesh Observer 是否已註冊
- 不引入對 MRTK2 的編譯時依賴，無 MRTK2 環境下安全回報「不支援」

### 3.2 `SpatialDataUploader`

- 監聽 GenAI DataChannel 的文字訊息，分派處理 Server 指令
- 收到 `spatial_capability_query` → 觸發探測 → 回報 `spatial_capability_report`
- 收到 `spatial_authority_assign` → 標記為權威 → 訂閱 MRTK2 事件
- 收到 `spatial_sync_request` → 全量快照上傳 → 送出 `spatial_sync_complete`
- 持續同步（每 2 秒輪詢）：偵測 MRTK2 Observer 中的新增/更新/移除，送出增量訊息
- 收到 `spatial_authority_revoke` → 停止上傳、取消訂閱

---

## 四、Server 端新增元件

### 4.1 `SpatialDataStore`

- Singleton，儲存所有空間資料
- `Dictionary<string, StoredQuad>` — 以 quadId 為 key
- `Dictionary<string, StoredMesh>` — 以 meshId 為 key
- 每筆記錄 `sourceClientId`，支援按 Client 批次刪除 (`RemoveAllFromClient`)
- 提供事件：`OnQuadUpserted` / `OnQuadDeleted` / `OnMeshUpserted` / `OnMeshDeleted` / `OnClientDataCleared` / `OnAllCleared`

### 4.2 `SpatialAuthorityManager`

- Singleton，管理空間資料權威選舉與同步狀態
- **能力探測**：新 Client 連線時主動發送 `spatial_capability_query`，記錄回報至 `ClientSpatialState`
- **權威選舉**：若無現有權威且有具備能力的 Client → 自動選舉
- **同步流程**：選出權威 → 發送 `spatial_authority_assign` + `spatial_sync_request` → Status = Syncing → 等待 `spatial_sync_complete` → Status = Ready
- **斷線處理**：權威 Client 斷線 → 清除其資料 → Status = Transferring → 搜尋下一個權威 → 找到則重新同步、找不到則 Status = None
- **僅接受權威資料**：非權威 Client 送來的空間資料一律忽略

### 4.3 狀態機

```
None → Syncing → Ready → (authority lost) → Transferring → Syncing / None
```

| 狀態 | 含義 |
|------|------|
| `None` | 無空間資料、無權威 |
| `Syncing` | 權威已指定，初步同步中 |
| `Ready` | 同步完成，資料可用 |
| `Transferring` | 前任權威離線，正在轉移 |

---

## 五、檔案清單

### Client（`3dog-rt-unity-client/Assets/Scripts/`）

| 路徑 | 狀態 |
|------|------|
| `GenAIDataChannel.cs` | 修改 |
| `GenAIDataChannelTextInput.cs` | 修改 |
| `GenAIDataChannelProtocol.cs` | 修改 |
| `GenAI/GenAICaptureHandler.cs` | 修改 |
| `Spatial/SpatialMessages.cs` | **新增** |
| `Spatial/SpatialSerializer.cs` | **新增** |
| `Spatial/SpatialCapabilityDetector.cs` | **新增** |
| `Spatial/SpatialDataUploader.cs` | **新增** |

### Server（`3dog-rt-unity-server/Assets/Scripts/`）

| 路徑 | 狀態 |
|------|------|
| `GenAIDataChannel.cs` | 修改 |
| `GenAIDataChannelManager.cs` | 修改 |
| `GenAIDataChannelTextInput.cs` | 修改 |
| `GenAIDataChannelProtocol.cs` | 修改 |
| `GenAI/CapturePhotoHandler.cs` | 修改 |
| `Spatial/SpatialMessages.cs` | **新增** |
| `Spatial/SpatialSerializer.cs` | **新增** |
| `Spatial/SpatialDataStore.cs` | **新增** |
| `Spatial/SpatialAuthorityManager.cs` | **新增** |

### 文件

| 路徑 | 狀態 |
|------|------|
| `3dog-node-backend/docs/architecture/04-larr.md` | 修改 |
| `3dog-node-backend/docs/changelogs/2026-03-30_spatial-data-channel.md` | **新增**（本文件） |
