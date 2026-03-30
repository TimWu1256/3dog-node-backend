# Unity MRTK 2 Mixed Reality 應用程式

## 與真實世界表面進行物理互動的技術指南

**文件版本**：1.0  
**編寫日期**：2026 年 3 月  
**適用範圍**：Unity 2020.3 / 2021.3 LTS + MRTK 2.8+（HoloLens 2 為主要目標平台）  
**作者**：Grok（基於使用者開發討論與業界最佳實踐整理）  
**目的**：完整整理 MRTK 2 中「讓虛擬物件與真實牆壁、地板發生物理碰撞」的各項技術方案、差異、效能考量與實作細節，供開發團隊參考。

---

## 目錄

- [1. 引言](#1-引言)
- [2. 核心概念與技術基礎](#2-核心概念與技術基礎)
  - 2.1 Spatial Awareness（空間感知）
  - 2.2 SLAM（裝置底層）
  - 2.3 Scene Understanding（場景理解）
- [3. AR Foundation 的 ARPlaneManager](#3-ar-foundation-的-arplanemanager)
- [4. 技術方案比較](#4-技術方案比較)
- [5. 效能影響與最佳化策略](#5-效能影響與最佳化策略)
- [6. 實作步驟（MRTK 2）](#6-實作步驟mrtk-2)
  - 6.1 Spatial Awareness 物理碰撞設定
  - 6.2 ARPlaneManager 物理碰撞設定
- [7. 程式碼範例](#7-程式碼範例)
- [8. 推薦實踐與注意事項](#8-推薦實踐與注意事項)
- [9. 常見問題與排錯](#9-常見問題與排錯)
- [10. 參考資源](#10-參考資源)

---

## 1. 引言

在 Unity MRTK 2 開發 Mixed Reality 應用程式時，常見需求是讓虛擬物件（帶 Rigidbody）與真實環境發生物理互動，例如撞到真實牆壁、掉落在地板上、滾動或靜止。本文件完整整理三種主要方案：

- **MRTK Spatial Awareness**（空間感知）—— 產生完整空間網格（Spatial Mesh），提供最高細節的物理碰撞。
- **MRTK Scene Understanding**（場景理解）—— 語義化分類（Floor / Wall 等），適合智慧放置。
- **AR Foundation ARPlaneManager** —— 跨平台平面偵測，效能較輕量。

文件涵蓋啟用方式、功能差異、程式碼範例、效能影響與最佳化，符合業界技術文件標準（清晰結構、對照表、程式碼區塊、實作步驟）。

---

## 2. 核心概念與技術基礎

### 2.1 Spatial Awareness（空間感知）

**功能**：MRTK 將裝置掃描的空間網格（Spatial Mesh）轉為 Unity 可用的 GameObject，並自動加上 `Mesh Collider`，讓 Unity PhysX 物理引擎與真實環境互動。

**關鍵特性**：

- 產生高細節三角形網格（可撞到細微凹凸）。
- 自動為每塊網格建立 GameObject + Mesh Collider。
- 物理碰撞完全由 Unity 物理引擎負責（Rigidbody + Collider）。
- **預設狀態**：**關閉**。單純匯入 MRTK 不會自動啟用，必須在 Profile 中手動勾選。

**啟用方式**：

1. 選取場景中的 `MixedRealityToolkit` 物件。
2. Inspector → **Spatial Awareness System** → 勾選 **Enable Spatial Awareness System**。
3. 選擇 **Windows Mixed Reality Spatial Mesh Observer**。
4. 設定 `Physics Layer`（預設 Layer 31）、`Level of Detail`（Coarse / Medium / Fine）、`Display Options`（Occlusion / None 推薦）。

### 2.2 SLAM（Simultaneous Localization and Mapping）

- **本質**：HoloLens 2 硬體與 Windows Mixed Reality 運行時的底層技術。
- MRTK 本身不實作 SLAM，而是**直接使用裝置產生的 SLAM 結果**（位置追蹤 + 空間網格資料）。
- Spatial Awareness 與 Scene Understanding 皆建立在 SLAM 之上。

### 2.3 Scene Understanding（場景理解）

**功能**：MRTK 2 實驗性功能（`WindowsSceneUnderstandingObserver`），僅支援 HoloLens 2。

- 提供**語義分類**（Floor、Wall、Ceiling、Platform 等）。
- 同時回傳 `SceneQuads`（簡化平面）與完整 Spatial Mesh snapshot。
- 適合需要「知道這是地板還是牆壁」的智慧互動。
- **缺點**：延遲較高、AI 處理成本較大，MRTK 3 已建議改用 AR Foundation。

---

## 3. AR Foundation 的 ARPlaneManager

**功能**：Unity AR Foundation 核心組件，負責即時偵測與追蹤現實環境中的平面（水平 / 垂直）。

**關鍵特性**：

- 自動為每個平面建立 `ARPlane` GameObject，並可加上 `Mesh Collider`。
- 可取得平面數量、位置、尺寸（`size`）、邊界頂點（`boundary`）。
- **無語義分類**（僅區分 Horizontal / Vertical）。
- **跨平台支援**：HoloLens 2（OpenXR）、Meta Quest、Android（ARCore）、iOS（ARKit）等。

**在 MRTK 2 中的整合方式**：

1. Package Manager 安裝 `AR Foundation` + `OpenXR Plugin` + `Microsoft Mixed Reality OpenXR Plugin`。
2. 新增 `AR Session Origin`，將 MRTK Main Camera 指定給它。
3. 在 `AR Session Origin` 上加入 `ARPlaneManager` 組件。
4. 設定 `Detection Mode` 與 `Plane Prefab`（內含 `MeshCollider`）。

**可取得的平面資訊**：

- 平面總數：`planeManager.trackables.Count`
- 位置：`plane.transform.position`
- 尺寸：`plane.size`（Vector2）
- 邊界：`plane.boundary`

---

## 4. 技術方案比較

| 項目                       | Spatial Awareness (MRTK 2)   | Scene Understanding (MRTK 2)                       | ARPlaneManager (AR Foundation) |
| -------------------------- | ---------------------------- | -------------------------------------------------- | ------------------------------ |
| **資料類型**               | 原始高細節三角形網格         | 語義化物件（Floor/Wall 等）+ Quads + Mesh snapshot | 簡化平面 + 邊界頂點            |
| **語義分類**               | 無                           | 有                                                 | 無（僅水平/垂直）              |
| **碰撞精細度**             | 最高（可撞細微凹凸）         | 高（含網格 snapshot）                              | 中等（平面簡化）               |
| **產生的 GameObject 數量** | 多（數十～數百塊）           | 中等                                               | 少（5～20 個）                 |
| **延遲**                   | 極低（即時）                 | 中高（AI 處理）                                    | 中等                           |
| **跨平台支援**             | 主要 HoloLens 2              | 僅 HoloLens 2                                      | 全平台                         |
| **適合場景**               | 真實物理碰撞（撞牆、掉地板） | 智慧吸附、導航                                     | 簡單平面吸附、多平台專案       |
| **MRTK 2 整合難度**        | 原生內建                     | 原生（實驗性）                                     | 需額外安裝 AR Foundation       |

---

## 5. 效能影響與最佳化策略

HoloLens 2 目標 60 FPS，過多 GameObject + MeshCollider 會增加 Draw Call、PhysX 計算與記憶體。

### 效能影響對照

- **Spatial Awareness**：影響較大（網格數多、MeshCollider 非凸）。
- **ARPlaneManager**：影響較小（平面數少、Mesh 簡單）。

### 最佳化建議（Spatial Awareness 重點）

1. **Level of Detail** → **Coarse** 或 **Medium**（避免 Fine）。
2. **Display Options** → **Occlusion** 或 **None**（不渲染，只留 Collider）。
3. **Update Interval** → 1～2 秒。
4. **Observer Extents** → 限制為玩家附近（5m × 5m）。
5. **Physics Layer Matrix** → 只開必要碰撞層。
6. Rigidbody 僅在需要時將 `Is Kinematic = false`。
7. 不使用時可程式控制 `CoreServices.SpatialAwarenessSystem.Disable()`。

ARPlaneManager 本身已較輕量，可進一步關閉 `enabled` 或只偵測 Horizontal。

---

## 6. 實作步驟（MRTK 2）

### 6.1 Spatial Awareness 物理碰撞設定

1. 啟用 Spatial Awareness（見 2.1）。
2. 虛擬物件加入 `Rigidbody`（Use Gravity = true，Is Kinematic = false）+ 適當 Collider。
3. 確認 Physics Layer 允許碰撞。
4. ObjectManipulator 釋放時切換 Kinematic 狀態以繼續物理。

### 6.2 ARPlaneManager 物理碰撞設定

1. 安裝 AR Foundation 與 OpenXR。
2. 新增 AR Session Origin + ARPlaneManager。
3. Plane Prefab 加入 Mesh Collider。
4. 訂閱 `planesChanged` 事件處理新增/更新平面。

---

## 7. 程式碼範例

### 7.1 ARPlaneManager 平面資訊監聽

```csharp
public class PlaneInfoExample : MonoBehaviour
{
    public ARPlaneManager planeManager;

    void OnEnable() => planeManager.planesChanged += OnPlanesChanged;

    private void OnPlanesChanged(ARPlanesChangedEventArgs args)
    {
        Debug.Log($"目前平面數量：{planeManager.trackables.Count}");

        foreach (var plane in args.added)
        {
            Debug.Log($"新平面 → 位置：{plane.transform.position}，尺寸：{plane.size}");
        }
    }
}
```

### 7.2 Spatial Awareness 動態控制（進階）

```csharp
// 程式啟動時自動開啟
CoreServices.SpatialAwarenessSystem.Enable();

// 釋放物件後繼續物理
rigidbody.isKinematic = false;
```

（完整範例可參考 MRTK 官方 GitHub 與 AR Foundation 文件）

---

## 8. 推薦實踐與注意事項

- **主要目標為 HoloLens 2 + 真實物理碰撞** → 優先使用 **Spatial Awareness**（Coarse LOD + Occlusion）。
- **多平台專案或簡單吸附** → 使用 **ARPlaneManager**。
- **需要語義分類** → 使用 **Scene Understanding**（或 MRTK 3 + AR Foundation 替代方案）。
- Player Settings 務必勾選 **Spatial Perception** 權限。
- 開發階段建議使用 MRTK Diagnostics 即時監控 FPS、Draw Call、Physics 時間。
- ObjectManipulator 抓取後記得處理物理狀態切換。

---

## 9. 常見問題與排錯

- **Spatial Awareness 未產生網格** → 確認已勾選 Enable + Spatial Perception 權限 + 正確 Observer。
- **物件穿透真實牆壁** → Physics Layer 是否為 Layer 31？碰撞矩陣是否允許？
- **ARPlaneManager 無平面出現** → AR Session Origin 是否正確設定 Camera？Detection Mode 是否包含 Horizontal？
- **效能掉 FPS** → 立即將 LOD 改 Coarse + Display = None。

---

## 10. 參考資源

- Microsoft MRTK 2 官方文件：Spatial Awareness System
- Unity AR Foundation 手冊：ARPlaneManager
- HoloLens 2 開發文件：Spatial Mapping & Scene Understanding
- MRTK GitHub 範例專案

---

**文件結束**  
本文件已完整涵蓋本次討論所有技術細節與研究成果。如需更新特定版本細節、加入更多程式碼或圖示，請提供最新 MRTK / Unity 版本資訊。

開發順利！🚀
