# 3DOG (3D Object Generation) Node Backend

**LLM 驅動的 3D 物件生成服務**，包含：

| 服務                           | 埠號   | 說明                                                                                       | 必要 |
| ------------------------------ | ------ | ------------------------------------------------------------------------------------------ | ---- |
| **agents** (LangGraph)         | `3600` | Python agent 圖（`orchestrator` + `craft3d` + `animation_agent`），透過 langgraph-cli 啟動 | ✅   |
| **craft3d** (Node.js)          | `3601` | Three.js 渲染服務，程式碼 → GLB + PNG                                                      | ✅   |
| **realtime-monitor** (Node.js) | `3681` | OpenAI Realtime API 示範（僅本地開發用）                                                   | —    |

## 技術與工具

- Node.js 24 / TypeScript / Hono
- Python 3.13 / LangGraph / uv
- Playwright（headless Chromium）
- Docker（單一容器同時啟動所有必要服務）

## 環境變數

請將 `.env` 放在專案根目錄。容器部署時，從啟動容器的環境動態載入；映像檔內不包含 `.env` 檔案。

| 變數                               | 說明                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `GOOGLE_API_KEY`                   | Google Gemini API 金鑰（agents craft/revise 節點使用）                          |
| `GOOGLE_GENERATIVE_AI_API_KEY`     | 同上（部分套件的替代變數名稱）                                                  |
| `OPENAI_API_KEY`                   | OpenAI API 金鑰（agents review 節點、animation_agent、realtime-monitor 使用）   |
| `RENDER_SERVICE_URL`               | craft3d service 基礎 URL（預設 `http://localhost:3601`），用於建構 GLB 下載 URL |
| `RENDER_GLB_URL`                   | agents 呼叫 craft3d render 的完整 URL（預設 `{RENDER_SERVICE_URL}/render`）     |
| `ANIMATION_AGENT_MODEL`            | animation_agent 使用的 OpenAI model（預設 `gpt-5.4`）                           |
| `ANIMATION_AGENT_REASONING_EFFORT` | animation_agent reasoning effort（預設 `medium`）                               |

## 快速開始（本地開發）

### craft3d

```bash
cd services/craft3d
npm install       # 同時安裝 Playwright Chromium
npm run dev       # 監聽 port 3601
```

### agents

包含兩個 LangGraph graph，均由 langgraph-cli 在 port 3600 提供服務：

| Graph             | Assistant ID   | 說明                                                                                                |
| ----------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `orchestrator`    | `orchestrator` | Unity Realtime API 會話的 context 管理器；記錄事件、路由工具呼叫至 sub-agent                        |
| `craft3d`         | `craft3d`      | 3D 物件生成管線（Gemini 生成/修訂 → 渲染 → OpenAI 審查）；由 orchestrator 以 sub-agent 方式呼叫     |
| `animation_agent` | —              | 從 craft3d job 生成 Unity C# runtime planner；由 orchestrator 在 craft3d 成功後呼叫，不直接對外服務 |

```bash
cd packages/agents_server
uv sync
uv run langgraph dev --host 0.0.0.0 --port 3600 --no-browser --n-jobs-per-worker 8
```

### realtime-monitor（選用）

```bash
cd services/realtime-monitor
npm install
npm run dev       # 監聽 port 3681
```

## 測試（craft3d）

```bash
npm test
# 等同於 cd services/craft3d && npm test
```

## Docker 容器部署

單一容器同時運行 **agents**（port 3600）與 **craft3d**（port 3601）。

Docker 提供兩種方式：**自行建置** 與 **拉取 GHCR 雲端映像**。

### 方式一：自行建置（build）

```bash
npm run docker:build   # 建置映像
npm run docker:up      # 啟動（-d 背景）
npm run docker:logs    # 查看 logs
npm run docker:down    # 停止並移除
```

### 方式二：拉取 GHCR 映像（免 clone 專案）

在任意空資料夾中，下載 compose 檔並放置 `.env`：

```bash
curl -L https://github.com/cch137/3dog-node-backend/raw/master/infra/docker-compose.ghcr.yml -o docker-compose.yml
```

```bash
npm run docker:ghcr:up:pull   # 拉取最新映像並啟動
npm run docker:ghcr:logs      # 查看 logs
npm run docker:ghcr:down      # 停止並移除
```

或直接用 docker compose：

```bash
docker compose pull
docker compose up -d
```

### 健康檢查

```bash
curl http://localhost:3601/healthz
# {"status":"ok","uptime":...}
```

## 容器啟動順序

`docker-entrypoint.sh` 會：

1. 確認無 `.env` / `*.key` 機密檔案
2. 確認 craft3d 的 `node_modules` 與 `dist` 存在
3. 背景啟動 LangGraph agents（port 3600）
4. 背景啟動 craft3d（port 3601）
5. 若任一服務異常退出，立即關閉容器
