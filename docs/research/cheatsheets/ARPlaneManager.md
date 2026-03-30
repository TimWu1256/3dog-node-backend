# Unity AR Foundation — ARPlaneManager 技術速查手冊

**文件版本**：1.0  
**編寫日期**：2026 年 3 月  
**涵蓋版本**：AR Foundation 5.x（穩定）/ 6.x（最新），本文以 **6.0** 為主線標註差異  
**用途**：AI Agent 知識庫更新用 Cheatsheet；以最精練方式涵蓋 ARPlaneManager 完整 API、資料結構、事件模型、Raycast 整合與物理碰撞實作  
**官方文件來源**：[AR Foundation 6.0 Plane Detection](https://docs.unity3d.com/Packages/com.unity.xr.arfoundation@6.0/manual/features/plane-detection/arplanemanager.html)

---

## 1. 核心架構

AR Foundation 採用 **Subsystem 抽象層**：`ARPlaneManager` 是 `ARTrackableManager` 的具象子類別，底層委託 `XRPlaneSubsystem`（由各平台 Provider 實作）。

```
ARPlaneManager : ARTrackableManager<XRPlaneSubsystem, ..., BoundedPlane, ARPlane>
```

啟用時自動啟動 Subsystem；停用時暫停偵測（不銷毀已存在的平面）。裝置若不支援平面偵測，`OnEnable` 時會自動 disable 自身。

---

## 2. 必要套件與場景設定

| 套件                                         | 用途                                   |
| -------------------------------------------- | -------------------------------------- |
| `com.unity.xr.arfoundation`                  | 核心抽象層                             |
| `com.unity.xr.arcore`                        | Android / Meta Quest Provider          |
| `com.unity.xr.arkit`                         | iOS Provider                           |
| `com.unity.xr.openxr` + 各平台 OpenXR Plugin | HoloLens 2 / Meta Quest（OpenXR 路徑） |

**場景最低需求**：`AR Session` + `XR Origin`（6.x）或 `AR Session Origin`（≤5.x）。  
`ARPlaneManager` 掛在 **XR Origin** 的 GameObject 上。

---

## 3. ARPlaneManager 屬性與方法

| 成員                        | 型別                                                | 說明                                                                |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| `planePrefab`               | `GameObject`                                        | 偵測到平面時實例化的 Prefab，可含 `MeshCollider`、`MeshRenderer` 等 |
| `requestedDetectionMode`    | `PlaneDetectionMode`                                | 設定偵測模式（可執行期間動態切換）                                  |
| `currentDetectionMode`      | `PlaneDetectionMode`（唯讀）                        | 目前 Subsystem 實際使用的模式                                       |
| `trackables`                | `TrackableCollection<ARPlane>`                      | 所有目前被追蹤的平面（可 `foreach`）                                |
| `trackablesChanged`（6.x）  | `UnityEvent<ARTrackablesChangedEventArgs<ARPlane>>` | 新增/更新/移除回呼                                                  |
| `planesChanged`（≤5.x）     | `Action<ARPlanesChangedEventArgs>`                  | 同上，舊版 API 名稱                                                 |
| `GetPlane(TrackableId)`     | `ARPlane` / `null`                                  | 依 ID 查找                                                          |
| `descriptor`                | `XRPlaneSubsystemDescriptor`                        | 查詢平台是否支援各可選功能                                          |
| `SetTrackablesActive(bool)` | `void`                                              | 批次啟用/停用所有 trackable GameObject                              |

### PlaneDetectionMode（Flags Enum）

```csharp
PlaneDetectionMode.Nothing        // 0 — 不偵測
PlaneDetectionMode.Horizontal     // 水平面
PlaneDetectionMode.Vertical       // 垂直面
PlaneDetectionMode.NotAxisAligned // 非軸對齊（6.0 新增，僅 Meta OpenXR 支援）
PlaneDetectionMode.Everything     // 全部
```

---

## 4. ARPlane 資料模型

每個偵測到的平面對應一個 `ARPlane` 組件（掛在自動產生的 GameObject 上）。

| 屬性                     | 型別                                      | 說明                                                                       |
| ------------------------ | ----------------------------------------- | -------------------------------------------------------------------------- |
| `trackableId`            | `TrackableId`                             | 唯一識別碼                                                                 |
| `trackingState`          | `TrackingState`                           | `None` / `Limited` / `Tracking`                                            |
| `alignment`              | `PlaneAlignment`                          | `HorizontalUp` / `HorizontalDown` / `Vertical` / `NotAxisAligned` / `None` |
| `classifications`（6.x） | `PlaneClassifications`（Flags）           | 語義分類，見下方清單                                                       |
| `center`                 | `Vector3`                                 | 世界空間 3D 中心                                                           |
| `centerInPlaneSpace`     | `Vector2`                                 | 平面本地空間 2D 中心                                                       |
| `normal`                 | `Vector3`                                 | 世界空間法線                                                               |
| `size`                   | `Vector2`                                 | 長寬（公尺）                                                               |
| `extents`                | `Vector2`                                 | 半長寬（`size / 2`）                                                       |
| `boundary`               | `NativeArray<Vector2>`                    | 凸邊界頂點（平面本地空間），邊界形狀會隨掃描成長                           |
| `infinitePlane`          | `UnityEngine.Plane`                       | 對應的無限平面（可用於數學計算）                                           |
| `subsumedBy`             | `ARPlane` / `null`                        | 若此平面已被另一個平面合併，指向合併者                                     |
| `boundaryChanged`        | `Action<ARPlaneBoundaryChangedEventArgs>` | 邊界頂點變化事件（受 `vertexChangedThreshold` 控制）                       |
| `vertexChangedThreshold` | `float`                                   | 頂點變化閾值（公尺），低於此值不觸發 `boundaryChanged`                     |
| `destroyOnRemoval`       | `bool`                                    | 移除時是否自動銷毀 GameObject（預設 `true`）                               |

### PlaneClassifications（6.0 Flags Enum）

```
None, Floor, WallFace, Ceiling, Table, Seat, Couch,
SeatOfAnyType, DoorFrame, WindowFrame, WallArt,
InvisibleWallFace, Other
```

> **注意**：`classification`（單數，非 Flags）在 6.0 已標記 `[Obsolete]`，應改用 `classifications`。  
> 分類支援依平台而異：ARKit（iOS 12+）、visionOS、Meta OpenXR 支援；ARCore 目前**不支援**。

---

## 5. 事件訂閱（版本差異重點）

### AR Foundation 6.x — `trackablesChanged`

```csharp
[SerializeField] ARPlaneManager planeManager;

void OnEnable()
    => planeManager.trackablesChanged.AddListener(OnTrackablesChanged);

void OnDisable()
    => planeManager.trackablesChanged.RemoveListener(OnTrackablesChanged);

void OnTrackablesChanged(ARTrackablesChangedEventArgs<ARPlane> changes)
{
    foreach (var p in changes.added)   { /* 新平面 */ }
    foreach (var p in changes.updated) { /* 更新 — 檢查 trackingState */ }
    foreach (var p in changes.removed) { /* 移除 — 不要手動 Destroy */ }
}
```

### AR Foundation ≤5.x — `planesChanged`

```csharp
void OnEnable()  => planeManager.planesChanged += OnPlanesChanged;
void OnDisable() => planeManager.planesChanged -= OnPlanesChanged;

void OnPlanesChanged(ARPlanesChangedEventArgs args)
{
    // args.added / args.updated / args.removed (List<ARPlane>)
}
```

---

## 6. Plane Prefab 配置（含物理碰撞）

Plane Prefab 是讓虛擬物件與真實平面產生物理互動的關鍵。推薦組件組合：

| 組件                          | 必要性           | 說明                                                                               |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `ARPlane`                     | 自動加入         | Manager 會確保存在                                                                 |
| `ARPlaneMeshVisualizer`       | 推薦             | 自動將 boundary 轉為 `Mesh`，並餵給 `MeshFilter` / `MeshCollider` / `LineRenderer` |
| `MeshFilter` + `MeshRenderer` | 視覺化用         | 渲染平面（可用透明材質）                                                           |
| `MeshCollider`                | **物理碰撞必須** | 讓 Rigidbody 物件可落在平面上                                                      |
| `LineRenderer`                | 選用             | 繪製邊界線                                                                         |

> **重點**：若只需碰撞不需視覺化，可省略 `MeshRenderer` 但保留 `MeshCollider` + `ARPlaneMeshVisualizer`。

---

## 7. 搭配 ARRaycastManager（觸控放置物件）

`ARRaycastManager` 提供 AR 空間的 Raycast（非 Physics Raycast），直接對 trackable 做碰撞偵測。

```csharp
[SerializeField] ARRaycastManager raycastManager;
List<ARRaycastHit> hits = new();

void Update()
{
    // 新版 Input System 可用 EnhancedTouch
    if (Input.touchCount == 0 || Input.GetTouch(0).phase != TouchPhase.Began)
        return;

    if (raycastManager.Raycast(Input.GetTouch(0).position, hits, TrackableType.PlaneWithinPolygon))
    {
        var hit = hits[0]; // 按距離排序，[0] 最近
        Pose pose = hit.pose;

        if (hit.trackable is ARPlane plane)
        {
            Debug.Log($"Hit {plane.alignment} plane, size={plane.size}");
            // 在 pose.position / pose.rotation 放置物件
        }
    }
}
```

**Raycast 方法簽章**：

```csharp
bool Raycast(Vector2 screenPoint, List<ARRaycastHit> hitResults,
             TrackableType trackableTypes = TrackableType.AllTypes)

bool Raycast(Ray ray, List<ARRaycastHit> hitResults,
             TrackableType trackableTypes = TrackableType.AllTypes)
```

**常用 TrackableType Flags**：`PlaneWithinPolygon`、`PlaneWithinBounds`、`PlaneEstimated`、`FeaturePoint`、`AllTypes`。

---

## 8. 綜合範例：偵測 + 碰撞 + Raycast 放置 + 分類查詢

此單一腳本展示最多常見場景：

```csharp
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

public class PlaneInteractionDemo : MonoBehaviour
{
    [SerializeField] ARPlaneManager planeManager;
    [SerializeField] ARRaycastManager raycastManager;
    [SerializeField] GameObject objectToPlace;

    readonly List<ARRaycastHit> _hits = new();

    void OnEnable()
    {
        // 6.x API（若用 ≤5.x，改用 planesChanged += ...）
        planeManager.trackablesChanged.AddListener(OnTrackablesChanged);

        // 動態切換偵測模式
        planeManager.requestedDetectionMode = PlaneDetectionMode.Everything;
    }

    void OnDisable()
        => planeManager.trackablesChanged.RemoveListener(OnTrackablesChanged);

    void OnTrackablesChanged(ARTrackablesChangedEventArgs<ARPlane> changes)
    {
        foreach (var plane in changes.added)
        {
            Debug.Log($"[Added] id={plane.trackableId} " +
                      $"alignment={plane.alignment} " +
                      $"size={plane.size} " +
                      $"classifications={plane.classifications}");

            // 為有 MeshCollider 的 Prefab 平面加上物理層（可選）
            plane.gameObject.layer = LayerMask.NameToLayer("ARPlane");
        }

        foreach (var plane in changes.updated)
        {
            if (plane.trackingState == TrackingState.Limited)
                Debug.Log($"[Limited] {plane.trackableId} left FOV");
        }

        // removed：不要 Destroy —— Manager 自行管理
    }

    void Update()
    {
        if (Input.touchCount == 0 || Input.GetTouch(0).phase != TouchPhase.Began)
            return;

        if (!raycastManager.Raycast(Input.GetTouch(0).position, _hits,
                                    TrackableType.PlaneWithinPolygon))
            return;

        var hit  = _hits[0];
        var pose = hit.pose;

        // 放置物件（含 Rigidbody 即可與 MeshCollider 平面互動）
        Instantiate(objectToPlace, pose.position, pose.rotation);

        // 取得被擊中的平面資訊
        if (hit.trackable is ARPlane p)
        {
            Debug.Log($"Placed on {p.alignment} plane " +
                      $"(center={p.center}, normal={p.normal}, " +
                      $"boundary verts={p.boundary.Length})");
        }
    }

    // --- 輔助：列舉所有平面 ---
    void LogAllPlanes()
    {
        Debug.Log($"Total planes: {planeManager.trackables.count}");
        foreach (var p in planeManager.trackables)
        {
            Debug.Log($"  {p.trackableId}: {p.alignment}, " +
                      $"size={p.size}, tracking={p.trackingState}");
        }
    }

    // --- 輔助：檢查平台可選功能 ---
    void CheckCapabilities()
    {
        var d = planeManager.descriptor;
        Debug.Log($"Horizontal={d.supportsHorizontalPlaneDetection} " +
                  $"Vertical={d.supportsVerticalPlaneDetection} " +
                  $"Arbitrary={d.supportsArbitraryPlaneDetection} " +
                  $"BoundaryVerts={d.supportsBoundaryVertices} " +
                  $"Classification={d.supportsClassification}");
    }
}
```

---

## 9. 平台功能支援矩陣

| 功能           | ARCore | ARKit     | visionOS | Meta OpenXR | XR Simulation |
| -------------- | ------ | --------- | -------- | ----------- | ------------- |
| 水平面偵測     | ✅     | ✅        | —        | ✅          | ✅            |
| 垂直面偵測     | ✅     | iOS 11.3+ | ✅       | ✅          | ✅            |
| 非軸對齊面偵測 | —      | —         | —        | ✅          | —             |
| 邊界頂點       | ✅     | ✅        | ✅       | ✅          | ✅            |
| 語義分類       | —      | iOS 12+   | ✅       | ✅          | —             |

> HoloLens 2 在 AR Foundation 6.0 的 platform support 表中**未明確列出**（原生以 MRTK Spatial Awareness 為主），需透過 Microsoft Mixed Reality OpenXR Plugin 橋接。

---

## 10. 生命週期與注意事項

- **Added**：首次偵測到平面。
- **Updated**：邊界、位置、追蹤狀態可能每幀變化；平面會隨掃描逐漸成長。
- **Removed**：平面不再有效（可能被 subsume）。`subsumedBy` 屬性可查詢合併去向。
- **絕對不要** `Destroy()` ARPlane 或其 GameObject — 由 Manager 管理，手動銷毀會導致錯誤。
- 停用 `ARPlaneManager` 時已存在的平面保留但不再更新，效能可回收。
- 若需在平面上固定內容且平面邊界持續變化，應建立 **ARAnchor** 並將內容 parent 到 Anchor。

---

## 11. 效能建議

| 策略                                   | 說明                                             |
| -------------------------------------- | ------------------------------------------------ |
| 僅偵測需要的方向                       | `requestedDetectionMode = Horizontal` 可減少運算 |
| 不需要時停用 Manager                   | `planeManager.enabled = false`                   |
| Plane Prefab 避免複雜 Shader           | 平面數可達 5–20 個，每個都會渲染                 |
| `vertexChangedThreshold` 調高          | 減少 `boundaryChanged` 觸發頻率                  |
| 利用 `trackingState` 隱藏 Limited 平面 | 減少不必要的渲染與碰撞                           |

---

## 12. 版本遷移速查

| 項目         | ≤ 5.x                         | 6.x                                  |
| ------------ | ----------------------------- | ------------------------------------ |
| 場景根物件   | `AR Session Origin`           | `XR Origin`                          |
| 事件 API     | `planesChanged`（C# event）   | `trackablesChanged`（UnityEvent）    |
| 分類         | `PlaneClassification`（enum） | `PlaneClassifications`（Flags enum） |
| 偵測模式     | 無 `NotAxisAligned`           | 新增 `NotAxisAligned`                |
| 查找物件     | `FindObjectOfType`            | `FindAnyObjectByType`（效能較佳）    |
| require 組件 | `ARSessionOrigin`             | `XROrigin`                           |

---

## 13. 參考連結

- [AR Foundation 6.0 — ARPlaneManager](https://docs.unity3d.com/Packages/com.unity.xr.arfoundation@6.0/manual/features/plane-detection/arplanemanager.html)
- [AR Foundation 6.0 — ARPlane API](https://docs.unity3d.com/Packages/com.unity.xr.arfoundation@6.0/api/UnityEngine.XR.ARFoundation.ARPlane.html)
- [AR Foundation 6.0 — Platform Support](https://docs.unity3d.com/Packages/com.unity.xr.arfoundation@6.0/manual/features/plane-detection/platform-support.html)
- [AR Foundation 6.0 — PlaneClassifications Enum](https://docs.unity3d.com/Packages/com.unity.xr.arfoundation@6.0/api/UnityEngine.XR.ARSubsystems.PlaneClassifications.html)
- [AR Foundation Samples GitHub](https://github.com/Unity-Technologies/arfoundation-samples)
- [Unity Learn — Configuring Plane Detection](https://learn.unity.com/tutorial/configuring-plane-detection-for-ar-foundation)

---
