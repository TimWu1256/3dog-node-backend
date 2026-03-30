# MRTK 2 — Spatial Awareness & Scene Understanding Cheatsheet

**適用版本**：MRTK 2.8.x / Unity 2020.3–2021.3 LTS / HoloLens 2  
**核心命名空間**：

```
Microsoft.MixedReality.Toolkit.SpatialAwareness          // Spatial Awareness 核心
Microsoft.MixedReality.Toolkit.Experimental.SpatialAwareness // Scene Understanding (實驗性)
Microsoft.MixedReality.Toolkit.WindowsSceneUnderstanding.Experimental
```

---

## 1. Spatial Awareness System（空間感知）

### 1.1 系統架構

系統核心為 `IMixedRealitySpatialAwarenessSystem`，透過 **Spatial Observer**（資料提供者）取得平台底層的空間掃描資料。每個 Observer 負責將裝置 SLAM 結果轉為 Unity `GameObject`（含 `MeshFilter` + `MeshCollider`）。

**入口點**：`CoreServices.SpatialAwarenessSystem`

### 1.2 核心介面

| 介面 | 用途 |
|------|------|
| `IMixedRealitySpatialAwarenessSystem` | 系統層級：啟停所有 Observer、註冊事件 Handler |
| `IMixedRealitySpatialAwarenessObserver` | 單個 Observer 的 Resume / Suspend / ClearObservations |
| `IMixedRealitySpatialAwarenessMeshObserver` | Mesh 專用：存取 `Meshes` 字典、設定 `DisplayOption`、`LevelOfDetail` |
| `IMixedRealityDataProviderAccess` | 取得特定型別的 Observer 實例 |

### 1.3 內建 Observer 類別

| 類別 | 說明 |
|------|------|
| `WindowsMixedRealitySpatialMeshObserver` | 裝置執行時使用，讀取 HoloLens 即時 SLAM 網格 |
| `SpatialObjectMeshObserver` | Editor 離線模擬用，載入預錄 3D 模型（`.obj`）模擬空間網格 |

### 1.4 關鍵資料類別

#### `SpatialAwarenessMeshObject`

每塊空間網格的包裝物件。

```csharp
// 關鍵屬性
meshObject.Id           // int — 唯一識別碼
meshObject.GameObject   // GameObject — 場景中的實體
meshObject.Filter       // MeshFilter — 可存取 Filter.mesh（Mesh 資料）
meshObject.Renderer     // MeshRenderer
meshObject.Collider     // MeshCollider（自動加入，用於 PhysX 碰撞）
```

### 1.5 Profile 設定參數速查

| Profile 參數 | 型別 | 說明 |
|--------------|------|------|
| `StartupBehavior` | enum | `AutoStart`（預設） / `ManualStart` |
| `ObservationExtents` | Vector3 | 觀測範圍（公尺），如 `(5,5,5)` |
| `ObserverShape` | enum | `AxisAlignedCube` / `UserAlignedCube` / `Sphere` |
| `IsStationaryObserver` | bool | true = 固定原點；false = 跟隨使用者 |
| `UpdateInterval` | float | 更新間隔（秒），建議 1–3 秒 |
| `LevelOfDetail` | enum | `Coarse` / `Medium` / `Fine` |
| `DisplayOption` | enum | `None` / `Visible` / `Occlusion` |
| `PhysicsLayer` | int | 預設 Layer 31（`Spatial Awareness`） |
| `VisibleMaterial` | Material | 可見時使用的材質 |
| `OcclusionMaterial` | Material | 遮蔽模式材質 |

### 1.6 核心 API 用法

```csharp
using Microsoft.MixedReality.Toolkit;
using Microsoft.MixedReality.Toolkit.SpatialAwareness;

// ——— 取得 Observer ———
var observer = CoreServices.GetSpatialAwarenessSystemDataProvider<IMixedRealitySpatialAwarenessMeshObserver>();

// 或指定名稱
var dataAccess = CoreServices.SpatialAwarenessSystem as IMixedRealityDataProviderAccess;
var namedObs = dataAccess.GetDataProvider<IMixedRealitySpatialAwarenessMeshObserver>("Windows Mixed Reality Spatial Mesh Observer");

// ——— 啟停控制 ———
CoreServices.SpatialAwarenessSystem.ResumeObservers();   // 全部恢復
CoreServices.SpatialAwarenessSystem.SuspendObservers();  // 全部暫停
observer.Resume();   // 單個恢復
observer.Suspend();  // 單個暫停

// ——— 啟停整個系統 ———
CoreServices.SpatialAwarenessSystem.Enable();
CoreServices.SpatialAwarenessSystem.Disable();

// ——— 遍歷已知網格 ———
foreach (SpatialAwarenessMeshObject meshObj in observer.Meshes.Values)
{
    Mesh m = meshObj.Filter.mesh;       // 取得 Unity Mesh
    int layer = meshObj.GameObject.layer; // 確認 Physics Layer
    // m.vertices, m.triangles, m.normals 可直接使用
}

// ——— 動態切換顯示模式 ———
observer.DisplayOption = SpatialAwarenessMeshDisplayOptions.Occlusion;
observer.DisplayOption = SpatialAwarenessMeshDisplayOptions.None; // 隱藏渲染但保留 Collider
```

### 1.7 事件監聽模式

```csharp
using SpatialAwarenessHandler = IMixedRealitySpatialAwarenessObservationHandler<SpatialAwarenessMeshObject>;

public class MeshEventReceiver : MonoBehaviour, SpatialAwarenessHandler
{
    void OnEnable()  => CoreServices.SpatialAwarenessSystem.RegisterHandler<SpatialAwarenessHandler>(this);
    void OnDisable() => CoreServices.SpatialAwarenessSystem.UnregisterHandler<SpatialAwarenessHandler>(this);

    public void OnObservationAdded(MixedRealitySpatialAwarenessEventData<SpatialAwarenessMeshObject> e)
    {
        // e.Id            — 網格 ID
        // e.SpatialObject  — SpatialAwarenessMeshObject 實例
        // e.SpatialObject.Filter.mesh.vertexCount — 頂點數
        Debug.Log($"Mesh added: id={e.Id}, verts={e.SpatialObject.Filter.mesh.vertexCount}");
    }

    public void OnObservationUpdated(MixedRealitySpatialAwarenessEventData<SpatialAwarenessMeshObject> e)
    {
        // 網格被更新（重新掃描同一區域）
    }

    public void OnObservationRemoved(MixedRealitySpatialAwarenessEventData<SpatialAwarenessMeshObject> e)
    {
        // 網格被移除（超出觀測範圍）
    }
}
```

### 1.8 物理碰撞快速設定

```csharp
// 虛擬物件設定
[RequireComponent(typeof(Rigidbody), typeof(BoxCollider))]
public class PhysicsObject : MonoBehaviour
{
    void Start()
    {
        var rb = GetComponent<Rigidbody>();
        rb.useGravity = true;
        rb.isKinematic = false;
        // 確保物件所在 Layer 與 Layer 31 (Spatial Awareness) 在
        // Edit > Project Settings > Physics > Layer Collision Matrix 中允許碰撞
    }
}
```

---

## 2. Scene Understanding（場景理解）

### 2.1 系統概覽

Scene Understanding 是 MRTK 2.6+ 的**實驗性功能**，透過 `WindowsSceneUnderstandingObserver` 提供語義化的環境分類（Floor / Wall / Ceiling 等）。底層使用 Windows `Microsoft.MixedReality.SceneUnderstanding` SDK。

**僅支援 HoloLens 2 + Unity 2019.4+**。Remoting 需 MRTK 2.7.3+ 且使用 OpenXR。

### 2.2 安裝前置

1. Build Settings → Platform = **UWP**
2. 透過 **Mixed Reality Feature Tool** 安裝 `Scene Understanding` 套件
3. Player Settings → Capabilities → 勾選 **Spatial Perception**
4. 場景根層級需有 `AsyncCoroutineRunner` 元件的空 GameObject

### 2.3 Observer 類別

```
WindowsSceneUnderstandingObserver : BaseSpatialObserver, IMixedRealitySceneUnderstandingObserver
```

**命名空間**：`Microsoft.MixedReality.Toolkit.WindowsSceneUnderstanding.Experimental`

**實作介面**：`IMixedRealitySceneUnderstandingObserver`（繼承自 `IMixedRealityOnDemandObserver`）

### 2.4 `SpatialAwarenessSceneObject` 資料結構

Scene Understanding Observer 回傳的核心資料物件。

```csharp
// 命名空間：Microsoft.MixedReality.Toolkit.Experimental.SpatialAwareness

public class SpatialAwarenessSceneObject : BaseSpatialAwarenessObject
{
    // 繼承自 BaseSpatialAwarenessObject
    int Id { get; }
    GameObject GameObject { get; }
    MeshFilter Filter { get; }
    MeshRenderer Renderer { get; }

    // Scene Understanding 專有
    SpatialAwarenessSurfaceTypes SurfaceType { get; }  // 語義分類
    Vector3 Position { get; }                           // 世界座標
    Quaternion Rotation { get; }                        // 世界旋轉
    List<QuadData> Quads { get; }                       // 2D 平面資料
    List<MeshData> Meshes { get; }                      // 3D 網格資料
}
```

#### 巢狀類別

```csharp
// QuadData — 簡化矩形平面
public class QuadData
{
    Vector2 Extents { get; }            // 平面尺寸 (width, height)
    // 可透過 GameObject.transform 取得位置/旋轉
}

// MeshData — 完整三角形網格
public class MeshData
{
    Vector3[] Vertices { get; }
    int[] Triangles { get; }            // 三角形索引
    Vector2[] UVs { get; }
}
```

### 2.5 `SpatialAwarenessSurfaceTypes` 列舉

```csharp
[System.Flags]
public enum SpatialAwarenessSurfaceTypes
{
    Unknown    = 1,    // 無法分類
    Floor      = 2,    // 地板
    Ceiling    = 4,    // 天花板
    Wall       = 8,    // 牆壁
    Platform   = 16,   // 大型水平平台（桌面等）
    Background = 32,   // 不屬於以上類型
    World      = 64,   // 完整世界網格（watertight mesh snapshot）
    Inferred   = 128   // 推斷區域（無直接觀測資料）
}
// 使用 [Flags] 故可組合：SurfaceTypes = Floor | Wall | Ceiling
```

**注意**：MRTK 2.7.3 之前版本的 Inspector 下拉選單與實際 enum 值有映射 Bug（#9987），建議透過程式碼設定 `SurfaceTypes` 以避免問題。

### 2.6 Observer Profile 設定參數

| 參數 | 說明 |
|------|------|
| `SurfaceTypes` | 要偵測的語義類別（Flags 組合） |
| `ShouldLoadFromFile` | 是否載入序列化 `.bytes` 檔案（Editor 測試用） |
| `SerializedScene` | `.bytes` 檔案路徑 |
| `RequestPlaneData` | 是否請求 Quad 平面資料 |
| `RequestMeshData` | 是否請求完整 Mesh 資料 |
| `InferRegions` | 是否推斷未掃描區域 |
| `UsePersistentObjects` | 跨更新保留 ID（已知有記憶體問題 #10970） |
| `QueryRadius` | 觀測半徑（公尺） |
| `UpdateInterval` | 更新間隔（秒） |
| `CreateGameObjects` | 是否為每個 SceneObject 建立 GameObject |
| `AutoUpdate` | 是否自動定期更新 |

### 2.7 事件監聽模式

```csharp
using SceneHandler = IMixedRealitySpatialAwarenessObservationHandler<SpatialAwarenessSceneObject>;

public class SceneObjectReceiver : MonoBehaviour, SceneHandler
{
    void OnEnable()  => CoreServices.SpatialAwarenessSystem.RegisterHandler<SceneHandler>(this);
    void OnDisable() => CoreServices.SpatialAwarenessSystem.UnregisterHandler<SceneHandler>(this);

    public void OnObservationAdded(MixedRealitySpatialAwarenessEventData<SpatialAwarenessSceneObject> e)
    {
        var sceneObj = e.SpatialObject;

        // 語義分類
        if (sceneObj.SurfaceType == SpatialAwarenessSurfaceTypes.Floor)
        {
            // 對地板做處理：放置物件、設定 NavMesh 等
            Debug.Log($"Floor detected at {sceneObj.Position}, quads={sceneObj.Quads.Count}");
        }
        else if (sceneObj.SurfaceType == SpatialAwarenessSurfaceTypes.Wall)
        {
            // 牆壁：掛畫、吸附 UI
            foreach (var quad in sceneObj.Quads)
                Debug.Log($"  Wall quad size: {quad.Extents}");
        }

        // 若需要碰撞：手動為 Quad/Mesh 子物件加 Collider
        foreach (var meshData in sceneObj.Meshes)
        {
            // meshData.Vertices / meshData.Triangles 可建立 MeshCollider
        }

        // 按語義分配到不同 Layer（用於 Surface Magnetism / Physics 隔離）
        sceneObj.GameObject.transform.SetLayerRecursively(LayerMask.NameToLayer("Floor"));
    }

    public void OnObservationUpdated(MixedRealitySpatialAwarenessEventData<SpatialAwarenessSceneObject> e) { }
    public void OnObservationRemoved(MixedRealitySpatialAwarenessEventData<SpatialAwarenessSceneObject> e) { }
}
```

### 2.8 序列化場景（離線開發）

裝置執行時可透過 Observer 儲存場景快照：

```
User Folders/LocalAppData/[APP_NAME]/LocalState/PREFIX_yyyyMMdd_hhmmss.bytes
```

透過 **Windows Device Portal** 下載後，在 Observer Profile 設定 `ShouldLoadFromFile = true` 並指定 `.bytes` 路徑即可在 Editor 中重現場景。

---

## 3. 同時使用 Spatial Awareness + Scene Understanding

兩者可並存為 Spatial Awareness System 下的兩個 Observer。典型組合策略：

```
MixedRealityToolkit
 └─ Spatial Awareness System (Enabled)
     ├─ Observer 1: WindowsMixedRealitySpatialMeshObserver  ← 物理碰撞（Coarse LOD）
     └─ Observer 2: WindowsSceneUnderstandingObserver       ← 語義分類（Floor/Wall）
```

**策略**：Spatial Mesh 負責碰撞（`MeshCollider` 自動產生），Scene Understanding 負責語義（知道哪面是牆、哪面是地板），兩者互補。

### 3.1 綜合範例：物件掉落地板 + 吸附牆壁

```csharp
using Microsoft.MixedReality.Toolkit;
using Microsoft.MixedReality.Toolkit.SpatialAwareness;
using Microsoft.MixedReality.Toolkit.Experimental.SpatialAwareness;
using UnityEngine;

using MeshHandler  = IMixedRealitySpatialAwarenessObservationHandler<SpatialAwarenessMeshObject>;
using SceneHandler = IMixedRealitySpatialAwarenessObservationHandler<SpatialAwarenessSceneObject>;

/// <summary>
/// 綜合範例：監聽 Spatial Mesh（物理碰撞）+ Scene Understanding（語義分類），
/// 示範動態控制 Observer、遍歷資料、處理事件回呼。
/// </summary>
public class SpatialComboExample : MonoBehaviour, MeshHandler, SceneHandler
{
    [Header("掉落物件")]
    [SerializeField] private GameObject objectPrefab;

    [Header("牆壁吸附材質")]
    [SerializeField] private Material wallHighlightMat;

    private IMixedRealitySpatialAwarenessMeshObserver meshObserver;

    // ——— 生命週期 ———
    void OnEnable()
    {
        var system = CoreServices.SpatialAwarenessSystem;
        system.RegisterHandler<MeshHandler>(this);
        system.RegisterHandler<SceneHandler>(this);

        // 取得 Mesh Observer 參考（動態控制用）
        meshObserver = CoreServices.GetSpatialAwarenessSystemDataProvider
            <IMixedRealitySpatialAwarenessMeshObserver>();
    }

    void OnDisable()
    {
        var system = CoreServices.SpatialAwarenessSystem;
        system.UnregisterHandler<MeshHandler>(this);
        system.UnregisterHandler<SceneHandler>(this);
    }

    // ——— Spatial Mesh 事件（物理碰撞層） ———
    public void OnObservationAdded(MixedRealitySpatialAwarenessEventData<SpatialAwarenessMeshObject> e)
    {
        // 網格產生時自動帶有 MeshCollider，虛擬物件可直接碰撞
        Debug.Log($"[Mesh] Added id={e.Id}, tris={e.SpatialObject.Filter.mesh.triangles.Length / 3}");
    }

    public void OnObservationUpdated(MixedRealitySpatialAwarenessEventData<SpatialAwarenessMeshObject> e) { }
    public void OnObservationRemoved(MixedRealitySpatialAwarenessEventData<SpatialAwarenessMeshObject> e) { }

    // ——— Scene Understanding 事件（語義分類層） ———
    public void OnObservationAdded(MixedRealitySpatialAwarenessEventData<SpatialAwarenessSceneObject> e)
    {
        var obj = e.SpatialObject;

        switch (obj.SurfaceType)
        {
            case SpatialAwarenessSurfaceTypes.Floor:
                // 在地板正上方生成掉落物件
                if (objectPrefab != null)
                {
                    var spawnPos = obj.Position + Vector3.up * 2f;
                    var go = Instantiate(objectPrefab, spawnPos, Quaternion.identity);
                    var rb = go.GetComponent<Rigidbody>();
                    if (rb != null) { rb.useGravity = true; rb.isKinematic = false; }
                }
                break;

            case SpatialAwarenessSurfaceTypes.Wall:
                // 高亮牆壁 Quad
                if (wallHighlightMat != null)
                {
                    foreach (var r in obj.GameObject.GetComponentsInChildren<Renderer>())
                        r.material = wallHighlightMat;
                }
                // 讀取 Quad 尺寸
                foreach (var q in obj.Quads)
                    Debug.Log($"[Scene] Wall quad extents: {q.Extents}");
                break;

            case SpatialAwarenessSurfaceTypes.Ceiling:
            case SpatialAwarenessSurfaceTypes.Platform:
                break;
        }
    }

    public void OnObservationUpdated(MixedRealitySpatialAwarenessEventData<SpatialAwarenessSceneObject> e) { }
    public void OnObservationRemoved(MixedRealitySpatialAwarenessEventData<SpatialAwarenessSceneObject> e) { }

    // ——— 動態控制（可由 UI 呼叫） ———
    public void PauseSpatialMesh() => meshObserver?.Suspend();
    public void ResumeSpatialMesh() => meshObserver?.Resume();

    public void ToggleAllObservers(bool on)
    {
        if (on) CoreServices.SpatialAwarenessSystem.ResumeObservers();
        else    CoreServices.SpatialAwarenessSystem.SuspendObservers();
    }

    public void HideMeshVisuals()
    {
        if (meshObserver != null)
            meshObserver.DisplayOption = SpatialAwarenessMeshDisplayOptions.None;
    }
}
```

---

## 4. 效能注意事項

| 項目 | 建議 |
|------|------|
| Mesh LOD | 生產環境使用 `Coarse`，開發偵錯用 `Medium` |
| DisplayOption | 生產環境設 `None`（不渲染，僅碰撞）或 `Occlusion` |
| UpdateInterval | ≥ 1 秒，避免頻繁重建 MeshCollider |
| ObservationExtents | 限制在玩家附近 3–5 公尺 |
| Physics Layer Matrix | 僅開啟必要層間碰撞 |
| Scene Understanding 記憶體 | 每次更新會重建所有 GameObject（#10970），長時間執行需注意 GC |
| 不需要時關閉 | `SuspendObservers()` 或 `Disable()` |

---

## 5. 常見陷阱速查

| 問題 | 原因與解法 |
|------|-----------|
| 網格不出現 | 確認 Profile 勾選 Enable + Player Settings 勾選 Spatial Perception |
| 物件穿透牆壁 | 確認碰撞矩陣：物件 Layer 與 Layer 31 需允許碰撞 |
| Scene Understanding Quad 沒資料 | Observer Profile 需勾選 `RequestPlaneData` |
| Scene Understanding World Mesh 沒出現 | 需勾選 `RequestMeshData` |
| Inspector 設定 SurfaceTypes 行為異常 | MRTK < 2.7.3 Bug，改用程式碼設定 `observer.SurfaceTypes` |
| Editor 中無資料 | SU 不支援 Editor 即時執行，需設定 `ShouldLoadFromFile = true` 載入 `.bytes` |
| `AsyncCoroutineRunner` 警告 | 確保場景根層有掛載此元件的空 GameObject |

---

## 6. 參考資源

- [Spatial Awareness Getting Started](https://learn.microsoft.com/en-us/windows/mixed-reality/mrtk-unity/mrtk2/features/spatial-awareness/spatial-awareness-getting-started)
- [Configuring Mesh Observers via Code](https://learn.microsoft.com/en-us/windows/mixed-reality/mrtk-unity/mrtk2/features/spatial-awareness/usage-guide)
- [Configuring Mesh Observers for Device](https://learn.microsoft.com/en-us/windows/mixed-reality/mrtk-unity/mrtk2/features/spatial-awareness/configuring-spatial-awareness-mesh-observer)
- [Scene Understanding Observer](https://learn.microsoft.com/en-us/windows/mixed-reality/mrtk-unity/mrtk2/features/spatial-awareness/scene-understanding)
- [Scene Understanding SDK Overview](https://learn.microsoft.com/en-us/windows/mixed-reality/develop/unity/scene-understanding-sdk)
- [API: SpatialAwarenessSurfaceTypes](https://learn.microsoft.com/en-us/dotnet/api/microsoft.mixedreality.toolkit.spatialawareness.spatialawarenesssurfacetypes?view=mixed-reality-toolkit-unity-2020-dotnet-2.8.0)
- [API: SpatialAwarenessSceneObject](https://learn.microsoft.com/en-us/dotnet/api/microsoft.mixedreality.toolkit.experimental.spatialawareness.spatialawarenesssceneobject?view=mixed-reality-toolkit-unity-2020-dotnet-2.7.0)
- [MRTK 2 GitHub (Legacy)](https://github.com/microsoft/MixedRealityToolkit-Unity)
- [MRTK Example: DemoSpatialMeshHandler.cs](https://github.com/microsoft/MixedRealityToolkit-Unity/tree/main/Assets/MRTK/Examples/Demos/SpatialAwareness)
