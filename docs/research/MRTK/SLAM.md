---
question: SLAM 的用途是什麽？我從 scene understanding 拿到的資料格式長什麼樣（給我一些範例）？我可以用 SLAM 來做什麼？它和 scene understanding 有什麼不同？怎麼跟 scene understanding 搭配使用？
---

**是的，SLAM（Simultaneous Localization and Mapping，同時定位與建圖）是所有現代 AR/MR 頭戴裝置（包括 HoloLens 2）的核心基礎技術。**

### SLAM 的用途是什麼？

它的主要工作就是：

- **同時**計算頭戴裝置自己在真實世界的 **6DoF 位置與姿態**（Localization：我現在在哪、頭朝哪裡）
- **同時**即時建構周圍環境的 **3D 地圖**（Mapping：牆、地板、桌子是什麼形狀）

沒有 SLAM，就沒有穩定的全息圖、沒有正確的遮擋、沒有碰撞物理、也沒有空間錨點。  
HoloLens 2 內建的深度相機 + IMU + 視覺感測器就是靠一套**專有 SLAM 演算法**（類似 KinectFusion 的變形）在背景持續運作，產生「空間映射（Spatial Mapping）」的原始資料。

### 我可以用 SLAM 來做什麼？（在 HoloLens 2 / OpenXR 上）

你無法直接「呼叫 SLAM API」，但 SLAM 的輸出就是 **Spatial Mapping**（對應 OpenXR 的 XR_MSFT_spatial_mapping 擴充或舊 WinRT Perception API），你可以拿來：

- 即時遮擋（hologram 被真實牆壁擋住）
- 物理碰撞（球滾在地板上）
- 射線投射找平面放模型
- 導航網格（讓全息人物走路不穿牆）
- 建立自訂空間錨點的基礎

### 它和 Scene Understanding 有什麼不同？（官方最清楚對比）

| 項目         | SLAM / Spatial Mapping（低階）          | Scene Understanding（高階）                        |
| ------------ | --------------------------------------- | -------------------------------------------------- |
| **本質**     | 原始三角網格（raw mesh）                | AI 語意化 + 結構化（quads + watertight mesh）      |
| **資料格式** | 頂點 + 法線 + 索引（無語意）            | 平面（Quad）+ 物件類型（TABLE）+ 補完網格          |
| **延遲**     | 極低（每秒更新）                        | 較高（需呼叫 compute，幾百毫秒～幾秒）             |
| **範圍**     | 有限「泡泡」（使用者周圍 3~5 公尺快取） | 可指定大範圍（球/盒子），甚至補完未掃描區域        |
| **優點**     | 最精準、最即時、細節最多                | 語意清楚（知道這是桌子）、watertight（無洞）、好用 |
| **缺點**     | 沒標籤、可能有洞、需要自己寫很多邏輯    | 不能完全即時、計算較重                             |
| **最佳用途** | 遮擋、物理、即時更新                    | 放置物件、導航、語意互動                           |

官方明確說：**Scene Understanding 其實內含 Spatial Mapping 的快照**（開啟 EnableWorldMesh 就能同時拿到兩種資料），所以它幾乎是「SLAM 的升級版」。

### 我從 Scene Understanding 拿到的資料格式長什麼樣？（再給更完整範例）

```c
// 1. 最基礎的 component（每個東西都是這個）
XrSceneComponentMSFT {
    type:          XR_SCENE_COMPONENT_TYPE_PLANE_MSFT 或 MESH 或 OBJECT
    objectType:    XR_SCENE_OBJECT_TYPE_TABLE_MSFT / FLOOR_MSFT / WALL_MSFT ...
    pose:          XrPosef { position, orientation }   ← 這就是世界座標！
    bounds:        XrExtent2Df { width, height }       ← 平面大小
    id / parentId
}

// 2. 平面（最常用來放模型）
XrScenePlaneMSFT {
    pose, halfExtents, objectType = TABLE_MSFT
}

// 3. 網格（包含細節）
XrSceneMeshMSFT { vertexCount, triangleCount }
// → 再呼叫 xrGetSceneMeshBuffersMSFT 拿頂點/索引 buffer（跟 Spatial Mapping 一樣）
```

**實際開發者常看到的 Unity / C# 等效**：

- `SceneQuad[]` → 每個 Quad 有 `Pose`、`Size`、`SceneObjectType`（Microsoft 列舉：0=Unknown, 5=Table, 1=Floor...）
- `SceneMesh` → watertight 網格 + WorldMesh（就是 SLAM 原始網格的快照）

### 可以做到只用 SLAM / 只用 Scene Understanding 嗎？怎麼搭配最好？

**只用 SLAM（Spatial Mapping）**：可以，但你要自己寫平面偵測、語意分類，麻煩。  
**只用 Scene Understanding**：可以直接拿 Quad 放模型，但即時性較差。

**最佳搭配方式（官方推薦）**：

1. 先開啟 Spatial Mapping（低延遲 raw mesh，用來即時遮擋、物理）。
2. 同時或週期性呼叫 Scene Understanding（指定 query 範圍 + EnableWorldMesh + EnableSceneObjectMeshes）。
3. 結果：
   - 用 Scene Understanding 的 **Quad + objectType** 找到桌子 → 把你的 3D 模型放在它的 pose 上（超穩）。
   - 用它附帶的 **WorldMesh**（SLAM 快照）做精細遮擋。
   - 每幾秒重新 compute Scene Understanding 即可（不需要每 frame）。

這樣你就同時擁有「即時細節 + 語意智慧」，效能與易用度都最佳。

**想看程式碼？**

- OpenXR 原生範例：Microsoft GitHub OpenXR-MixedReality/samples/SceneUnderstandingUwp
- Unity：開 Mixed Reality OpenXR Plugin + 自己寫 Scene Observer（或用 MRTK 的 Spatial Awareness + Scene Understanding 範本）

如果你現在用 Unity / Unreal / Native，想看哪一種語言的完整片段（例如怎麼同時拿 SLAM mesh + Scene Quad 放模型），告訴我你的引擎和版本，我立刻給你可直接複製的程式碼！
