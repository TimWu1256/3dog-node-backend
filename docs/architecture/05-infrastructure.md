# 3DOG 架構 — 基礎設施、端口、環境變數、部署

---

## 基礎設施（請勿修改）

### node-dss（port 3000）

WebRTC 信號伺服器（Dead Simple Signalling），提供 FIFO 訊息佇列給 WebRTC P2P 連線建立使用。LARR Server 與 LARR Client 透過此服務交換 SDP offer/answer 與 ICE candidates。

### WebRTC-mod

針對 LARR 系統的 Unity WebRTC 套件客製化模組，以 PowerShell 腳本覆蓋 Unity 生成的 WebRTC 原生檔案。

---

## 通訊協定與端口

| 服務                | 端口 | 協定             | 說明                                                              |
| ------------------- | ---- | ---------------- | ----------------------------------------------------------------- |
| agents（LangGraph） | 3600 | HTTP/REST        | AI 管線入口（orchestrator + craft3d graphs，`/threads`, `/runs`） |
| craft3d             | 3601 | HTTP/REST        | Three.js → GLB 渲染                                               |
| realtime-monitor    | 3681 | HTTP/WebSocket   | Realtime API 事件監視器 + HoloLens capture relay                  |
| node-dss            | 3000 | HTTP/REST        | WebRTC 信號交換                                                   |
| OpenAI Realtime API | 443  | WSS              | AI 語音對話                                                       |
| LARR                | —    | WebRTC P2P + OSC | Unity Server ↔ HoloLens                                           |

---

## 環境變數

| 位置                               | 變數                 | 用途                                                                         |
| ---------------------------------- | -------------------- | ---------------------------------------------------------------------------- |
| `3dog-node-backend/.env`           | `GOOGLE_API_KEY`     | agents（Gemini）                                                             |
| `3dog-node-backend/.env`           | `OPENAI_API_KEY`     | realtime-demo                                                                |
| `3dog-node-backend/.env`           | `RENDER_SERVICE_URL` | craft3d service 基礎 URL（預設 `http://localhost:3601`），用於建構 `glb_url` |
| `3dog-node-backend/.env`           | `RENDER_GLB_URL`     | agents 呼叫 craft3d render 的完整 URL（預設 `{RENDER_SERVICE_URL}/render`）  |
| `StreamingAssets/OpenaiConfig.txt` | API Key              | SpaceWizard 讀取 OpenAI key                                                  |

---

## 部署

### 本機開發

```bash
# 1. 後端（需先建好 .env）
cd 3dog-node-backend
npm run docker:up          # 啟動 agents(:3600) + craft3d(:3601)
npm run docker:logs        # 查看日誌

# 或個別啟動
cd services/craft3d && npm run dev
cd packages/agents_server && uv run langgraph dev --host 0.0.0.0 --port 3600 --no-browser --n-jobs-per-worker 8

# 2. Unity Server
# 開啟 3dog-rt-unity-server 專案，確認 StreamingAssets/OpenaiConfig.txt 存在
# Play Mode 執行 GenAIServer 場景

# 3. node-dss（LARR 依賴）
cd node-dss && npm start    # port 3000
```

### Docker 部署

```bash
cd 3dog-node-backend
npm run docker:ghcr:up:pull   # 拉取最新映像並啟動
```

映像同時包含 agents（Python 3.13）與 craft3d（Node.js 24）兩個服務。
