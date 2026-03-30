# 3DOG 系統架構 — 總覽

## 目錄索引

| 文件 | 說明 |
|------|------|
| [00-overview.md](00-overview.md) | 本文件：系統概覽、倉庫、架構圖、文件維護說明 |
| [01-backend.md](01-backend.md) | 3dog-node-backend（craft3d、agents、realtime-monitor） |
| [02-unity-server.md](02-unity-server.md) | 3dog-rt-unity-server（Realtime AI、語音、3D 生成流程） |
| [03-unity-client.md](03-unity-client.md) | 3dog-rt-unity-client（HoloLens、MR 拍照流程） |
| [04-larr.md](04-larr.md) | LARR 子系統（視訊串流、DataChannel、GenAI 訊息格式） |
| [05-infrastructure.md](05-infrastructure.md) | 基礎設施、端口、環境變數、部署指令 |

---

## 架構文件維護說明

> **每次開始任務前，請先閱讀相關章節再動工。**

### 何時需要更新架構文件

凡是以下任何一項有所變更，**必須在同一個 changeset 中更新對應的架構文件**：

- 新增或移除服務、端點、DataChannel
- 新增或修改 LangGraph node、edge、state schema
- 修改服務間通訊方式或資料格式
- 變更端口分配或環境變數
- 新增或棄用 Unity 腳本元件

### 如何更新

1. 找到對應的章節文件（01–05）並更新內容
2. 若索引表需要反映新章節，更新 `00-overview.md` 的目錄
3. 架構圖（本文件）若整體資料流有異動，同步更新

### 不需要記錄的內容

- 函式簽名的細節（看程式碼）
- Git 歷史（看 git log）
- 暫時性的 WIP 狀態

---

## 系統概覽

3DOG 是一套 **LLM 驅動的混合現實體驗平台**，核心功能包含：
- 語音對話（OpenAI Realtime API，audio-to-audio）
- AI 生成 3D 物件（文字描述 → GLB 模型 → 匯入 Unity 場景）
- 遠端渲染串流至 HoloLens

系統分為三個開發範疇：**後端**、**Unity Server**、**Unity Client**。

## 專案倉庫

| 倉庫 | 說明 |
|------|------|
| `3dog/3dog-node-backend` | 後端服務（AI 管線、渲染服務） |
| `3dog/3dog-rt-unity-server` | Unity 伺服器端（PC，場景 authority） |
| `3dog/3dog-rt-unity-client` | Unity 客戶端（HoloLens） |
| `3dog/node-dss` | WebRTC 信號伺服器 |
| `3dog/WebRTC-mod` | Unity WebRTC 客製化模組 |

**技術亮點：** LLM-based Multi-Agent Systems、Realtime AI（audio-to-audio）、LLM-driven 3D object generation（text-to-3d）

---

## 系統架構圖

```
┌─────────────────────────────────────────────────────────────────┐
│                        HoloLens                                 │
│                  3dog-rt-unity-client                           │
│              LARR Client (WebRTC P2P)                           │
└──────────────────────┬──────────────────────────────────────────┘
                       │ 視訊串流 + 物件同步 (LARR / WebRTC)
                       │ WebRTC 信號交換 → node-dss (:3000)
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│                   PC（伺服器端）                                 │
│                 3dog-rt-unity-server                            │
│                                                                 │
│   ┌──────────────┐   tool call    ┌─────────────────────────┐  │
│   │  SpaceWizard │ ─────────────► │ ObjectGenerationHandler │  │
│   │  (Realtime   │  transcript    │  (路由至 orchestrator)   │  │
│   │   Agent)     │ ◄─────────────┤                          │  │
│   └──────┬───────┘                └────────────┬────────────┘  │
│          │                                     │               │
│   ┌──────▼───────┐                    ┌────────▼────────────┐  │
│   │  AudioDuplex │                    │  GLBImporter /      │  │
│   │  (麥克風 +   │                    │  GLBManager         │  │
│   │   揚聲器)    │                    │  (匯入場景)          │  │
│   └──────────────┘                    └─────────────────────┘  │
│          │                                     │               │
└──────────┼─────────────────────────────────────┼───────────────┘
           │                                     │
           │ WebSocket (wss://api.openai.com)     │ HTTP POST/GET
           ▼                                     ▼
   OpenAI Realtime API              ┌─────────────────────────┐
   (gpt-4o-realtime)                │   3dog-node-backend     │
                                    │                         │
                                    │  agents  :3600 (Python) │
                                    │  ├─ orchestrator graph  │
                                    │  └─ craft3d graph       │
                                    │  craft3d :3601 (Node.js)│
                                    └─────────────────────────┘
```

---

## 核心資料流

### 語音對話觸發 3D 生成

```
[連線建立]
  Realtime API 接通（SpaceWizard.OnSessionReady）
  → ObjectGenerationHandler.BeginOrchestratorSession()
  → POST /threads → sessionThreadId（整個會話共用）

[使用者說話]
  AudioDuplex 擷取麥克風 PCM16
  → SpaceWizard.SendAudio() → OpenAI Realtime WebSocket
  → OpenAI server_vad 偵測發言結束，自動 commit
  → Whisper 轉錄完成 → conversation.item.input_audio_transcription.completed
    → SpaceWizard 轉發 transcript 事件到 orchestrator（fire-and-forget）

[AI 回應]
  OpenAI 回應（語音 + transcript_done + 可能有 tool call）
  → AudioDuplex 播放 AI 語音
  → response.audio_transcript.done → SpaceWizard 轉發 transcript_done 事件到 orchestrator

[AI 呼叫工具]
  response.function_call_arguments.done → SpaceWizard.HandleToolCall("create_3d_object")
  → ObjectGenerationHandler.StartGenerationProcess(name, desc, callId, ...)
  → POST /threads/{sessionThreadId}/runs（tool_call 事件）→ runId
  → onCreated(runId) → SpaceWizard 告知 AI「生成中，請稍候」

[orchestrator 處理 tool_call run]
  record_event_node: 記錄 tool_call 事件到 events 日誌
  invoke_craft3d_node: 以 sub-agent 呼叫 craft3d graph
    → craft3d 生成、渲染、審查（1-3 輪）
    → 取得 SubagentResult { job_id, glb_url }
  記錄 tool_result 事件到 events 日誌
  run 狀態變為 "success"

[Unity 接收結果]
  Poll GET /threads/{sessionThreadId}/runs/{runId} → status="success"
  GET /threads/{sessionThreadId}/state → values.subagent_result.glb_url
  GLBImporter.ImportGLBToScene(glb_url)
  → GameObject 出現在 Unity 場景
  → LARR 串流更新後的視角至 HoloLens
  → SpaceWizard 告知 AI「生成完成」
```

### HoloLens 視角串流

```
Unity Server（場景渲染）
  → LARR-Server 擷取視訊幀
  → WebRTC P2P（信號透過 node-dss）
  → LARR-Client 接收並顯示
  → HoloLens 使用者看到場景視角
```
