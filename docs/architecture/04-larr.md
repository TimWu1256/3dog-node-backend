# 3DOG 架構 — LARR 子系統

LARR（Localization-Assisted Remote Rendering）是本系統的視訊串流與物件同步子系統，負責將 Unity Server 端的場景即時渲染結果傳輸至 HoloLens，並在兩端之間同步使用者頭部位姿與物件變換。

---

## 系統定位

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

---

## DataChannel 一覽

| Channel | ID | 方向 | 格式 | 用途 | 觸發時機 |
|---------|-----|------|------|------|----------|
| **Camera** | 1 | Client → Server | CSV: `posX,posY,posZ,rotX,rotY,rotZ` | 使用者頭部追蹤 | 每幀 |
| **Interact** | 3 | 雙向 | JSON: `{objName: {pos, rot, scale}}` | 物件操作同步 | 變換發生時 |
| **PlayerSync** | 4 | Server → Client | JSON: `{objectName, Position, Rotation, QuadScale, isActive, timestamp}` | 串流相機同步 | 持續發送／有變化時 |
| **PlayerAck** | 5 | Client → Server | 字串: `"200 OK:ObjectName"` | 確認收到同步資料 | 收到 PlayerSync 後 |
| **ObjectFreeze** | 6 | Server → Client | JSON: `{objectName, timestamp}` | 暫停視訊播放 | Server 主動觸發 |
| **GenAI** | 7 | 雙向 | UTF-8 字串（自訂） | GenAI 應用層自訂資料傳輸 | 應用層主動觸發 |

> **注意：** WebRTC SCTP max streams 預設上限為 1024，channel ID 須在 0–1023 之間。

---

## Server 端核心元件

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
| `GenAIDataChannelManager` | 監聽 `CreatePeer.OnPeerCreated`，自動在每個新 peer 的 PeerConnection 上掛載 `GenAIDataChannel`；提供 `BroadcastText()` / `SendTextTo()` 等 API 與集中接收（`OnTextReceived`）；peer 生命週期事件（`OnPeerAdded` / `OnPeerRemoved`）|
| `SpatialDataStore` | Singleton；儲存所有空間資料（quads + meshes），每筆記錄來源 `sourceClientId`，支援按 Client 批次刪除 |
| `SpatialAuthorityManager` | Singleton；管理 Client 空間能力探測、權威選舉、同步狀態機，路由空間資料至 `SpatialDataStore`；同步流程每個步驟均有詳細 log |
| `SpatialMeshBuilder` | 訂閱 `SpatialDataStore.OnMeshUpserted/Deleted`，建立含 `MeshCollider` 的 GameObject（預設不渲染）以支援物理效果 |

---

## Client 端核心元件

| 元件 | 說明 |
|------|------|
| `ControlUserPosition` | 每幀讀取主相機位姿，序列化為 CSV 送出 Camera channel |
| `SendControlInformation` | 監控子物件變換，偵測到變化時序列化為 JSON 送出 Interact channel；以字典快取避免重複傳送 |
| `ControlVideoPlayer` | 接收 PlayerSync 資料，更新視訊 Quad 的位置與縮放；送出 PlayerAck；以 timestamp 去重避免舊訊息影響 |
| `FreezeVideoPlayer` | 接收 ObjectFreeze 指令，暫停對應物件的視訊播放 |
| `StreamingMonitor` | 監控 WebRTC transceiver 狀態，依 MlineIndex 啟用或停用對應的 Object 播放器 |
| `ReceiveInteract` | 接收 Interact channel 的物件變換更新，反序列化後同步本地場景 |
| `GenAIDataChannel` | 獨立於 LARR 的應用層 DataChannel（ID 7，label "GenAI"）；提供 `SendText()` / `SendBytes()` 與 `OnTextReceived` / `OnBytesReceived` 事件 |
| `SpatialCapabilityDetector` | 透過反射探測 MRTK2 空間感知功能是否可用（Scene Understanding / Spatial Mesh） |
| `SpatialDataUploader` | 監聽 Server 指令（authority、sync），負責上傳空間資料並追蹤增量變化 |

---

## 典型資料流：物件移動後的視角更新

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

---

## 設計要點

- **變換差異偵測**：Client 與 Server 皆以字典快取上一幀狀態，僅在有變化時才發送，降低不必要的網路負載。
- **DBSCAN 聚類**：Server 自動將空間上鄰近的物件分組，為合併渲染相機提供依據。
- **Timestamp 去重**：Client 丟棄 timestamp 早於已處理訊息的舊封包，避免亂序資料污染畫面。
- **可見性 Hysteresis**：`VolumetricObject` 提供 2 秒緩衝，避免物件在視錐邊緣反覆啟停閃爍。
- **動態相機框取**：`ControlStreamingCamera` 依目標物件包圍盒與使用者距離動態調整 FOV，確保物件始終充滿畫面。
- **多 Client 並行**：每個連線的 Client 擁有獨立的 PeerConnection 與串流相機，互不干擾。

---

## GenAI DataChannel（應用層擴充）

GenAI DataChannel 是疊加在現有 LARR WebRTC 連線上的應用層傳輸通道，完全在 LARR 模組外部實作，不修改任何 LARR 內部邏輯。

### Wire Format

每個 WebRTC DataChannel 幀均以 **1 byte 類型標記** 開頭，後接有效負載：

| 標記 | 值 | 負載 | 說明 |
|------|----|------|------|
| Text | `0x00` | UTF-8 字串 | JSON 文字訊息 |
| Binary | `0x01` | 原始 bytes | 二進位資料（未來 protobuf 等用途） |

接收端依據首位元組分派至 `OnTextReceived` 或 `OnBytesReceived`。

### 腳本一覽

**腳本位置：** `Assets/Scripts/`（client 與 server 各自獨立）

| 腳本 | 存在於 | 說明 |
|------|--------|------|
| `GenAIDataChannel` | Client + Server | 單一 PeerConnection 的 DataChannel 封裝；提供 `SendText()` / `SendBytes()`；`Setup()` 供 Manager 程式化初始化 |
| `GenAIDataChannelManager` | Server | Singleton；自動為每個 peer 建立 `GenAIDataChannel`；提供 `BroadcastText()` / `BroadcastBytes()` / `SendTextTo()` / `SendBytesTo()`；集中接收文字與二進位；peer 生命週期事件 |
| `GenAIDataChannelTextInput` | Client + Server | Inspector 測試工具（ContextMenu 觸發） |
| `GenAIDataChannelProtocol` | Client + Server | 靜態常數類別，定義所有 DataChannel 訊息的 `type` 字串，確保兩端一致 |

#### 空間資料相關腳本

| 腳本 | 存在於 | 說明 |
|------|--------|------|
| `SpatialMessages` | Client + Server | 所有空間訊息的 DTO 類別（`[Serializable]`，供 `JsonUtility` 使用） |
| `SpatialSerializer` | Client + Server | 集中序列化/反序列化入口；目前為 JSON，未來切換 protobuf 僅需修改此類別 |
| `SpatialCapabilityDetector` | Client | 透過反射探測 MRTK2 空間感知功能是否可用 |
| `SpatialDataUploader` | Client | 監聽 Server 指令，負責上傳空間資料並追蹤增量變化 |
| `SpatialDataStore` | Server | Singleton；儲存空間資料（quads + meshes），支援 CRUD 與按 Client 批次刪除 |
| `SpatialAuthorityManager` | Server | Singleton；管理能力探測、權威選舉、同步狀態機 |
| `SpatialMeshBuilder` | Server | 訂閱 `SpatialDataStore` mesh 事件，建立含 `MeshCollider` 的 GameObject（預設不渲染）以支援物理效果 |

### Server 資料流

```
任意 Client 送出文字訊息
  → GenAIDataChannel.OnTextReceived
  → GenAIDataChannelManager.OnTextReceived(senderId, message)  ← 集中處理點

Server 廣播文字
  → GenAIDataChannelManager.BroadcastText(message)
  → 所有已連線 Client 的 GenAIDataChannel.SendText()

Server 定向發送
  → GenAIDataChannelManager.SendTextTo(peerId, message)
  → 指定 Client 的 GenAIDataChannel.SendText()
```

### Peer 生命週期事件

```
[新 Client 連線]
  → CreatePeer.OnPeerCreated → GenAIDataChannelManager
  → 自動建立 GenAIDataChannel → 註冊 → 觸發 OnPeerAdded(peerId)

[Client 斷線]
  → PeerConnection GameObject 銷毀 → GenAIDataChannel.OnDisable()
  → 觸發 OnDisabled → GenAIDataChannelManager 取消註冊 → 觸發 OnPeerRemoved(peerId)
```

### 實作限制

- Channel ID 須在 0–1023（SCTP 預設 max streams），LARR 佔用 1–6，GenAI 使用 **7**（可在 Inspector 調整，兩端須一致）
- `GenAIDataChannelManager` 監聽 `CreatePeer.OnPeerCreated`，peer prefab 無需預先掛載 `GenAIDataChannel`

---

## GenAI DataChannel Message Protocol（訊息格式規範）

所有文字訊息均為 **UTF-8 JSON**，必須包含 `type` 字串欄位。接收端根據 `type` 值分派至對應的處理邏輯。所有 `type` 常數定義於 `GenAIDataChannelProtocol.cs`。

序列化目前使用 JSON（經由 `SpatialSerializer` 統一入口），設計上預留切換至 protobuf 的彈性。

### 訊息類型總覽

| `type` | 方向 | 觸發時機 |
|--------|------|----------|
| `capture_request` | Server → Client（廣播） | Server 需要所有連線 Client 截圖 |
| `capture_result` | Client → Server | Client 截圖成功 |
| `capture_error` | Client → Server | Client 截圖失敗 |
| `spatial_capability_query` | Server → Client（單播） | 新 Client 連線時，Server 詢問其空間能力 |
| `spatial_capability_report` | Client → Server | Client 回報支援的空間功能 |
| `spatial_authority_assign` | Server → Client（單播） | Server 指定該 Client 為空間資料權威 |
| `spatial_authority_revoke` | Server → Client（單播） | Server 撤銷權威身份 |
| `spatial_sync_request` | Server → Client（單播） | Server 要求權威 Client 開始上傳全部空間資料 |
| `spatial_sync_complete` | Client → Server | 權威 Client 確認初步同步完成 |
| `spatial_quad_upsert` | Client → Server | 建立或更新 Scene Understanding 四邊形 |
| `spatial_quad_delete` | Client → Server | 刪除 Scene Understanding 四邊形 |
| `spatial_mesh_upsert` | Client → Server | 建立或更新空間網格區塊 |
| `spatial_mesh_delete` | Client → Server | 刪除空間網格區塊 |

### `capture_request`

Server 廣播，要求所有連線 Client 執行截圖。

```json
{
  "type": "capture_request",
  "requestId": "7f3a1b2c4d5e6f7a8b9c0d1e2f3a4b5c",
  "prompt": "optional context hint for the AI"
}
```

| 欄位 | 型別 | 說明 |
|------|------|------|
| `type` | string | 固定值 `"capture_request"` |
| `requestId` | string | UUID（hex，無分隔符）；用於將回應與請求配對 |
| `prompt` | string | 選填；語意提示，可供 Client 端記錄用途 |

### `capture_result`

Client 截圖成功後回傳。

```json
{
  "type": "capture_result",
  "requestId": "7f3a1b2c4d5e6f7a8b9c0d1e2f3a4b5c",
  "imageBase64": "data:image/png;base64,iVBORw0KGgo..."
}
```

| 欄位 | 型別 | 說明 |
|------|------|------|
| `type` | string | 固定值 `"capture_result"` |
| `requestId` | string | 對應 `capture_request` 的 `requestId` |
| `imageBase64` | string | Base64 data URI，格式 `data:image/png;base64,<data>` |

### `capture_error`

Client 因任何原因無法截圖時回傳。**Client 必須回傳此訊息（不可靜默失敗），使 Server 能正確計算回應數量。**

```json
{
  "type": "capture_error",
  "requestId": "7f3a1b2c4d5e6f7a8b9c0d1e2f3a4b5c",
  "reason": "PhotoCapture API unavailable on this platform"
}
```

| 欄位 | 型別 | 說明 |
|------|------|------|
| `type` | string | 固定值 `"capture_error"` |
| `requestId` | string | 對應 `capture_request` 的 `requestId` |
| `reason` | string | 人類可讀的失敗原因，供 Server 記錄與 AI 回報使用 |

### Capture 廣播與收集流程

```
[Server] CapturePhotoHandler.StartCapture()
  ├─ 讀取 GenAIDataChannelManager.ConnectedPeerCount → N
  ├─ 若 N = 0：立即呼叫 onError（無 Client 連線）
  ├─ 訂閱 GenAIDataChannelManager.OnTextReceived
  ├─ 廣播 capture_request（requestId, prompt）
  └─ 等待收集（最多 10 秒）
        ├─ 每收到 capture_result / capture_error → 加入 results，記錄 senderId
        ├─ respondedIds.Count == N → 提前結束等待
        └─ 逾時 → 以已收到的 results 繼續（若 results 為空則呼叫 onError）

[Client] GenAICaptureHandler（每個 HoloLens）
  ├─ 收到 capture_request → MRCaptureManager.CaptureAsync()
  ├─ 成功 → 送出 capture_result（requestId, imageBase64）
  └─ 失敗 → 送出 capture_error（requestId, reason）

[Server] 收集完畢後
  → 對每個成功結果：SpaceWizard.SendConversationImage(imageBase64)
  → 觸發 AI 回應（含所有截圖）
```

> **Timeout 設計原則**：timeout 設 10 秒，針對的是「Client 無回應」的情境（如截圖 API hang、DataChannel 斷線）。若收到部分回應，Server 仍以已收到的結果繼續，不會因個別 Client 失敗而阻塞整個流程。

---

### Spatial 訊息

#### `spatial_capability_query`

Server 在新 Client 連線時主動發送，詢問其裝置是否支援空間資料。

```json
{ "type": "spatial_capability_query" }
```

#### `spatial_capability_report`

Client 回報其裝置支援的空間功能。

```json
{
  "type": "spatial_capability_report",
  "supportsSceneUnderstanding": true,
  "supportsSpatialMesh": true
}
```

| 欄位 | 型別 | 說明 |
|------|------|------|
| `supportsSceneUnderstanding` | bool | 是否支援 MRTK2 Scene Understanding（四邊形語義分類） |
| `supportsSpatialMesh` | bool | 是否支援 MRTK2 Spatial Mesh（三角形網格） |

#### `spatial_authority_assign`

Server 指定該 Client 為空間資料的權威來源。

```json
{ "type": "spatial_authority_assign" }
```

#### `spatial_authority_revoke`

Server 撤銷該 Client 的權威身份。Client 收到後應停止上傳。

```json
{ "type": "spatial_authority_revoke" }
```

#### `spatial_sync_request`

Server 要求權威 Client 開始上傳其持有的所有空間資料。Client 完成後必須送出 `spatial_sync_complete`。

```json
{ "type": "spatial_sync_request" }
```

#### `spatial_sync_complete`

權威 Client 確認初步空間資料同步已完成。Server 收到後才將狀態切換至 `Ready`。

```json
{ "type": "spatial_sync_complete" }
```

#### `spatial_quad_upsert`

Client → Server。建立或更新一個 Scene Understanding 四邊形（語義化平面）。

```json
{
  "type": "spatial_quad_upsert",
  "quadId": "42",
  "surfaceType": "floor",
  "position": { "x": 0.0, "y": -0.1, "z": 2.5 },
  "rotation": { "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0 },
  "extents":  { "x": 3.2, "y": 4.0 }
}
```

| 欄位 | 型別 | 說明 |
|------|------|------|
| `quadId` | string | 唯一識別碼（對應 MRTK2 `SpatialAwarenessSceneObject.Id`） |
| `surfaceType` | string | 語義分類：`floor`, `wall`, `ceiling`, `platform`, `unknown`, `background`, `world`, `inferred` |
| `position` | Vec3 | 世界座標位置 |
| `rotation` | Vec4 | 世界座標旋轉（quaternion） |
| `extents` | Vec2 | 四邊形尺寸（公尺）：x = 寬，y = 高 |

#### `spatial_quad_delete`

Client → Server。刪除一個 Scene Understanding 四邊形。

```json
{
  "type": "spatial_quad_delete",
  "quadId": "42"
}
```

#### `spatial_mesh_upsert`

Client → Server。建立或更新一個空間網格區塊。

```json
{
  "type": "spatial_mesh_upsert",
  "meshId": "7",
  "position": { "x": 0.0, "y": 0.0, "z": 0.0 },
  "rotation": { "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0 },
  "vertices": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
  "triangles": [0, 1, 2]
}
```

| 欄位 | 型別 | 說明 |
|------|------|------|
| `meshId` | string | 唯一識別碼（對應 MRTK2 `SpatialAwarenessMeshObject.Id`） |
| `position` | Vec3 | 世界座標位置 |
| `rotation` | Vec4 | 世界座標旋轉（quaternion） |
| `vertices` | float[] | 扁平化頂點陣列 `[x,y,z, x,y,z, ...]` |
| `triangles` | int[] | 三角形索引陣列 |

#### `spatial_mesh_delete`

Client → Server。刪除一個空間網格區塊。

```json
{
  "type": "spatial_mesh_delete",
  "meshId": "7"
}
```

---

## 空間資料狀態機（Spatial Readiness Status）

Server 端 `SpatialAuthorityManager` 維護一個全域狀態，描述「現實空間資料是否可用」：

```
                    ┌────────────────────────────────────────────┐
                    │                                            │
                    ▼                                            │
              ┌──────────┐    authority elected    ┌───────────┐ │
              │          │ ──────────────────────► │           │ │
     ────────►│   None   │                         │  Syncing  │ │
              │          │ ◄──── no capable ────── │           │ │
              └──────────┘      client             └─────┬─────┘ │
                    ▲                                    │       │
                    │                          sync_complete     │
                    │                                    │       │
                    │           ┌───────────────┐  ┌─────▼─────┐ │
                    │           │               │  │           │ │
                    └── no ──── │ Transferring  │◄─┤   Ready   │ │
                    capable     │               │  │           │ │
                                └───────┬───────┘  └───────────┘ │
                                        │                        │
                                        │   new authority found  │
                                        └────────────────────────┘
```

| 狀態 | 含義 | 觸發條件 |
|------|------|----------|
| `None` | 無空間資料、無權威 Client | 初始狀態；或所有具備能力的 Client 均離線 |
| `Syncing` | 權威已指定，初步同步進行中 | 權威 Client 被選出並收到 `spatial_sync_request` |
| `Ready` | 初步同步完成，空間資料可用且持續維護 | 收到權威 Client 的 `spatial_sync_complete` |
| `Transferring` | 前任權威離線，正在尋找新權威 | 權威 Client 斷線觸發 |

### 權威選舉流程

```
[新 Client 連線]
  → GenAIDataChannelManager.OnPeerAdded
  → SpatialAuthorityManager 發送 spatial_capability_query

[Client 回報能力]
  → spatial_capability_report → 記錄至 ClientSpatialState
  → 若目前無權威且該 Client 具備能力 → 選為權威

[權威 Client 斷線]
  → GenAIDataChannelManager.OnPeerRemoved
  → SpatialDataStore.RemoveAllFromClient(peerId)  ← 清除該 Client 的所有空間資料
  → Status → Transferring
  → 搜尋下一個具備能力的已連線 Client
    → 找到 → 選為新權威 → Syncing
    → 找不到 → None
```

### 空間資料同步流程

```
[Server] 選出權威 Client
  ├─ 發送 spatial_authority_assign
  ├─ 發送 spatial_sync_request
  └─ Status → Syncing

[Client] 收到 spatial_sync_request
  ├─ 遍歷所有 MRTK2 SceneObject → 逐一送出 spatial_quad_upsert
  ├─ 遍歷所有 MRTK2 SpatialMesh → 逐一送出 spatial_mesh_upsert
  └─ 全部完成 → 送出 spatial_sync_complete

[Server] 收到 spatial_sync_complete
  └─ Status → Ready

[持續同步] Client 定期輪詢 MRTK2 Observer（每 2 秒）
  ├─ 偵測到新增/更新 → spatial_quad_upsert / spatial_mesh_upsert
  └─ 偵測到移除 → spatial_quad_delete / spatial_mesh_delete
```

### 設計要點

- **序列化可替換**：所有空間訊息經由 `SpatialSerializer` 統一序列化/反序列化。目前為 JSON（`JsonUtility`），未來切換 protobuf 僅需修改該類別。
- **來源追蹤**：`SpatialDataStore` 為每筆空間資料記錄 `sourceClientId`，Client 斷線時可批次清除。
- **僅權威上傳**：Server 只接受來自權威 Client 的空間資料，非權威 Client 的上傳一律忽略。
- **無 MRTK2 硬依賴**：`SpatialCapabilityDetector` 與 `SpatialDataUploader` 均透過反射存取 MRTK2 API，在無 MRTK2 的環境下安全地回報「不支援」而非編譯錯誤。
- **狀態精確性**：`Syncing` 與 `Ready` 的切換嚴格依賴 `spatial_sync_complete`，不會在資料尚未完整時過早標記為可用。`Transferring` 明確反映權威轉移的過渡狀態。
