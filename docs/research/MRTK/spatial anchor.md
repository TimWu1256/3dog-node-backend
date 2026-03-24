---
question: 那麼空間錨點是否是可以完全免費無限制的使用，並且一樣與 scene understanding 一樣對設備要求不高。我從空間錨點拿到的資料格式長什麼樣（給我一些範例）？比如說我可以做到，只在一個錨點上放置一個我已有的 3D 模型之類的嗎？錨點的作用是什麽？如何設置？還是自動指定的？
---

**是的，不使用 MRTK 也可以直接使用 XR_MSFT_scene_understanding。**  
它是 **Microsoft 的 OpenXR vendor extension**（不是 MRTK 專屬），只要你的 OpenXR runtime（HoloLens 2 的 Windows Mixed Reality Runtime，或支援此 extension 的其他 runtime）有啟用，你就能用**原生 OpenXR API** 呼叫。

- 在 **Unity**：啟用 Mixed Reality OpenXR Plugin（不裝 MRTK），然後自己寫 C# P/Invoke 或用 native plugin wrapper 呼叫函式。
- 在 **Unreal / Native C++**：直接呼叫 `xrCreateSceneObserverMSFT` 等 API（官方有 UWP native sample 證明完全不依賴 MRTK）。
- 2026 年最新 OpenXR SDK 1.1.57 仍持續更新此 extension，沒有棄用跡象。

### 你從 Scene Understanding 拿到的資料格式長什麼樣？

你會拿到 **XrSceneComponentMSFT** 的陣列（可達數百個），每個 component 再根據 `type` 轉成對應的專屬結構。資料是**結構化 + 語意化**的（不是原始點雲）。

**主要結構範例（來自 OpenXR 1.1 spec，C 語言定義）：**

```c
// 基礎 component（所有東西都從這裡開始）
typedef struct XrSceneComponentMSFT {
    XrSceneComponentTypeMSFT    type;          // OBJECT / PLANE / MESH
    XrSceneObjectTypeMSFT       objectType;    // 語意類型，例如 TABLE
    XrPosef                     pose;          // 位置 + 旋轉
    XrExtent2Df                 bounds;        // 大小（2D 平面用）
    uint32_t                    id;            // 唯一 ID
    uint32_t                    parentId;      // 屬於哪個 object
} XrSceneComponentMSFT;

// 平面（最常用來放東西）
typedef struct XrScenePlaneMSFT {
    XrVector2f                  center;
    XrVector2f                  halfExtents;   // 長寬的一半
    XrPosef                     pose;          // 真正的世界座標
    XrSceneObjectTypeMSFT       objectType;    // TABLE / FLOOR / CEILING ...
    uint32_t                    id;
    uint32_t                    parentId;
} XrScenePlaneMSFT;

// 網格（Mesh）
typedef struct XrSceneMeshMSFT {
    uint32_t                    vertexCount;
    uint32_t                    triangleCount;
    uint32_t                    id;
    uint32_t                    parentId;
    // 頂點/索引 buffer 要另外呼叫 xrGetSceneMeshBuffersMSFT 取得
} XrSceneMeshMSFT;

// 物件（Object，包含多個 plane/mesh）
typedef struct XrSceneObjectMSFT {
    XrPosef                     pose;
    XrSceneObjectTypeMSFT       objectType;    // TABLE_MSFT = 5 等
    uint32_t                    componentCount;
    XrSceneComponentMSFT*       components;    // 子 component 陣列
} XrSceneObjectMSFT;
```

**語意類型（objectType）範例**（XR*SCENE_OBJECT_TYPE*...）：

- `TABLE_MSFT`（桌子）
- `FLOOR_MSFT`（地板）
- `CEILING_MSFT`（天花板）
- `WALL_MSFT`（牆）
- `DOOR_MSFT`、`WINDOW_MSFT`、`CHAIR_MSFT` 等（總共 20+ 種）

### 可以只用 Scene Understanding 就在桌子上放置一個已有的 3D 模型嗎？

**完全可以！** 這正是它的主要設計目的。

**步驟範例（偽碼 / Unity 概念）：**

1. 建立 observer + 呼叫 `xrComputeNewSceneMSFT`（指定要 plane + object）。
2. 取得 component 陣列。
3. 篩選 `objectType == XR_SCENE_OBJECT_TYPE_TABLE_MSFT` 且 `type == PLANE_MSFT` 的 component。
4. 呼叫 `xrLocateSceneComponentsMSFT` 取得**最新世界座標**（因為 pose 會跟隨頭戴裝置移動）。
5. 把你的 3D 模型放在那個 pose 上：

```csharp
// Unity 範例（假設你已寫好 OpenXR wrapper）
if (component.objectType == XR_SCENE_OBJECT_TYPE_TABLE_MSFT) {
    XrPosef tablePose = LocateComponent(component.id);  // 呼叫 locate 函式
    Vector3 pos = new Vector3(tablePose.position.x, tablePose.position.y + 0.01f, tablePose.position.z);  // 抬高 1cm 避免穿模
    Quaternion rot = new Quaternion(tablePose.orientation.x, ...);

    my3DModel.transform.SetPositionAndRotation(pos, rot);

    // 還可以用 halfExtents 對齊模型大小或做 bounding check
}
```

這樣你就**只靠 Scene Understanding** 就能把模型穩穩放在桌上（支援即時更新、語意分類、未掃描區域補完）。不用 ARPlane、不用 MRTK 的 Spatial Awareness，完全純 OpenXR。

如果你要完整 native 範例（C++），官方提供：
https://github.com/microsoft/OpenXR-MixedReality/tree/main/samples/SceneUnderstandingUwp  
（裡面 `Scene_Placement.cpp` 就是示範怎麼用這些 component 來做放置）。

想看 Unity 怎麼自己包裝這些 API，或有特定程式碼問題，再告訴我你的開發環境（Unity 版本、是否用 OpenXR Plugin），我可以給更精確的 wrapper 範例！
