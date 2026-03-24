# LangGraph CLI 完整參考文檔

> **版本**: langgraph-cli 0.4.x+ / langgraph-api 0.7.x  
> **更新日期**: 2026-03  
> **適用**: Python ≥3.11 / Node.js 20

---

## 1. 概述

LangGraph CLI 是用於本地構建與運行 **LangGraph Agent Server** 的命令行工具，由 LangChain 公司開發。它將 Graph 應用封裝為 HTTP API，提供 runs、threads、assistants、crons、store 等完整端點，並內建 checkpointing 持久化與長期記憶支援。

**核心價值**：

- 無需手動配置基礎設施，一鍵啟動本地開發環境或部署至生產
- 內建狀態持久化（PostgreSQL）、任務隊列、流式輸出
- 支援 Human-in-the-loop、長時間運行的 Agent workflow

---

## 2. 安裝

```bash
# Python (推薦使用 uv)
pip install -U langgraph-cli[inmem]   # 開發模式需 [inmem]
pip install -U langgraph-cli          # 生產/Docker 模式

# JavaScript/TypeScript
npx @langchain/langgraph-cli <command>
# 或全局安裝
npm install -g @langchain/langgraph-cli
```

---

## 3. 核心命令

| 命令                   | 用途                                  | Docker 需求 |
| ---------------------- | ------------------------------------- | ----------- |
| `langgraph dev`        | 開發模式，hot-reload，狀態存於記憶體  | ❌          |
| `langgraph up`         | 生產模式，Docker Compose + PostgreSQL | ✅          |
| `langgraph build`      | 構建 Docker image                     | ✅          |
| `langgraph dockerfile` | 生成 Dockerfile                       | ❌          |
| `langgraph new`        | 從模板創建新專案                      | ❌          |
| `langgraph deploy`     | 一鍵部署至 LangSmith Deployment       | ✅          |

### 3.1 langgraph dev

```bash
langgraph dev [OPTIONS]
  --host TEXT           # 綁定地址 (default: 127.0.0.1)
  --port INTEGER        # 埠號 (default: 2024)
  --no-reload           # 禁用熱重載
  --debug-port INTEGER  # 遠程調試埠
  --no-browser          # 不自動開啟瀏覽器
  -c, --config FILE     # 配置文件路徑 (default: langgraph.json)
```

**特點**: 輕量、無需 Docker、自動開啟 Studio UI、支援 IDE 斷點調試。

### 3.2 langgraph up

```bash
langgraph up [OPTIONS]
  -p, --port INTEGER    # 對外埠 (default: 8123)
  --wait                # 等待服務啟動完成
  --watch               # 文件變更時重啟
  --verbose             # 詳細日誌
  -d, --docker-compose  # 附加服務文件
```

**特點**: Docker Compose 堆疊（Agent Server + PostgreSQL），數據持久化。

### 3.3 langgraph build

```bash
langgraph build -t IMAGE_TAG [OPTIONS]
  --platform TEXT       # 目標平台 (e.g., linux/amd64,linux/arm64)
  --pull / --no-pull    # 使用最新/本地 base image
```

### 3.4 langgraph deploy (2026-03 新增)

```bash
langgraph deploy [OPTIONS]
langgraph deploy list     # 列出部署
langgraph deploy logs     # 查看日誌
langgraph deploy delete   # 刪除部署
```

一鍵構建 Docker image、推送至託管 registry、自動配置 Postgres + Redis，部署至 LangSmith Deployment。

### 3.5 langgraph new

```bash
langgraph new --template <TEMPLATE> <PATH>

# 可用模板
--template new-langgraph-project-python  # 基礎 Python 模板
--template deep-agent                    # 複雜工作流模板
--template simple-agent                  # 輕量模板
```

---

## 4. langgraph.json 配置結構

```jsonc
{
  "$schema": "https://langgra.ph/schema.json",

  // === 必要欄位 ===
  "dependencies": [".", "langchain_openai"], // pip 依賴或本地路徑
  "graphs": {
    "agent": "./src/agent/graph.py:graph", // name: "module_path:variable"
  },

  // === 可選欄位 ===
  "env": "./.env", // 環境變數文件
  "python_version": "3.11", // 3.11 | 3.12
  "image_distro": "wolfi", // wolfi (推薦) | debian | bookworm | bullseye
  "dockerfile_lines": [], // 額外 Dockerfile 指令

  // === 認證配置 ===
  "auth": {
    "path": "src/security/auth.py:auth", // 自定義認證模組
    "disable_studio_auth": "false", // 是否禁用 Studio 訪問
  },

  // === 存儲配置 ===
  "store": {
    "index": {
      "embed": "openai:text-embedding-3-small", // 嵌入模型
      "dims": 1536, // 向量維度
      "fields": ["$"], // 嵌入欄位 (["$"]=全文)
    },
  },

  // === HTTP 配置 ===
  "http": {
    "middleware_order": "auth_first", // auth_first | middleware_first
    "cors": {
      "allow_origins": ["https://example.com"],
      "allow_methods": ["GET", "POST"],
      "allow_credentials": true,
    },
  },

  // === Checkpointer TTL ===
  "checkpointer": {
    "ttl": { "strategy": "delete", "sweep_interval_minutes": 60 },
  },
}
```

### JavaScript/TypeScript 配置

```jsonc
{
  "graphs": { "agent": "./src/graph.ts:graph" },
  "node_version": "20",
  "env": ".env",
  "dockerfile_lines": [],
}
```

---

## 5. API 資源模型

Server 啟動後暴露 RESTful API，核心資源：

| 資源           | 說明                                 | 端點前綴      |
| -------------- | ------------------------------------ | ------------- |
| **Assistants** | Graph 配置實例，支援版本控制         | `/assistants` |
| **Threads**    | 對話容器，持久化狀態與歷史           | `/threads`    |
| **Runs**       | 單次執行，可 stateless 或關聯 thread | `/runs`       |
| **Crons**      | 定時任務調度                         | `/runs/crons` |
| **Store**      | 跨 thread 長期記憶存儲               | `/store`      |

---

## 6. SDK 快速使用

### Python

```python
from langgraph_sdk import get_client, get_sync_client

client = get_client(url="http://localhost:2024")  # async
# client = get_sync_client(url="http://localhost:2024")  # sync

# 創建 thread
thread = await client.threads.create()

# 流式執行
async for chunk in client.runs.stream(
    thread["thread_id"],
    "agent",  # assistant_id (langgraph.json 中的 graph name)
    input={"messages": [{"role": "user", "content": "Hello"}]},
    stream_mode="updates"
):
    print(chunk.data)
```

### JavaScript/TypeScript

```typescript
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });

const thread = await client.threads.create();

for await (const chunk of client.runs.stream(thread.thread_id, "agent", {
  input: { messages: [{ role: "user", content: "Hello" }] },
})) {
  console.log(chunk.data);
}
```

---

## 7. 自定義認證

```python
# src/security/auth.py
from langgraph_sdk import Auth

auth = Auth()

@auth.authenticate
async def authenticate(headers: dict) -> Auth.types.MinimalUserDict:
    api_key = headers.get(b"x-api-key")
    if not api_key or not is_valid(api_key):
        raise Auth.exceptions.HTTPException(status_code=401)
    return {"identity": api_key, "custom_field": "value"}

@auth.on.threads.create
async def on_thread_create(ctx, value):
    # 注入 owner metadata
    value.setdefault("metadata", {})["owner"] = ctx.user.identity
    return {"owner": ctx.user.identity}  # 過濾條件
```

在 `langgraph.json` 中啟用：

```json
{ "auth": { "path": "src/security/auth.py:auth" } }
```

---

## 8. Cron 定時任務

```python
# 創建 stateful cron (綁定 thread)
cron = await client.crons.create_for_thread(
    thread["thread_id"],
    "agent",
    schedule="0 9 * * *",  # 每日 9:00 UTC
    input={"messages": [{"role": "user", "content": "Daily report"}]}
)

# 創建 stateless cron
cron = await client.crons.create(
    "agent",
    schedule="27 15 * * *",
    input={"messages": [...]},
    on_run_completed="keep"  # keep | delete (default)
)

# 刪除
await client.crons.delete(cron["cron_id"])
```

---

## 9. Store (長期記憶)

```python
from langgraph.store.memory import InMemoryStore

store = InMemoryStore()

# 存儲
await store.aput(
    namespace=("user", "123", "preferences"),
    key="theme",
    value={"color": "dark"}
)

# 檢索
item = await store.aget(namespace=("user", "123", "preferences"), key="theme")

# 語義搜索 (需配置 index)
results = await store.asearch(
    namespace=("user", "123"),
    query="dark mode settings",
    limit=5
)
```

---

## 10. 部署選項

| 方式            | 描述                            | 適用場景         |
| --------------- | ------------------------------- | ---------------- |
| **Cloud SaaS**  | LangSmith 託管                  | 快速上線，免運維 |
| **BYOC**        | 在你的 VPC 運行，LangChain 管理 | 數據合規要求     |
| **Self-Hosted** | 完全自主部署                    | 企業內網         |

```bash
# 一鍵部署至 LangSmith
LANGSMITH_API_KEY=lsv2_... langgraph deploy
```

---

## 11. 開發工作流

```bash
# 1. 創建專案
langgraph new --template new-langgraph-project-python ./my-agent
cd my-agent

# 2. 安裝依賴
pip install -e .

# 3. 啟動開發服務器 (自動開啟 Studio)
langgraph dev

# 4. 構建生產 image
langgraph build -t my-agent:latest

# 5. 本地生產測試
langgraph up

# 6. 部署
langgraph deploy
```

---

## 12. 調試

### VSCode 配置

```json
{
  "name": "Attach to LangGraph",
  "type": "debugpy",
  "request": "attach",
  "connect": { "host": "0.0.0.0", "port": 5678 }
}
```

啟動時加入 debug 埠：

```bash
langgraph dev --debug-port 5678
```

---

## 13. 常見問題

| 問題                              | 解決方案                                                           |
| --------------------------------- | ------------------------------------------------------------------ |
| `ImportError: langgraph_api`      | 安裝 `langgraph-cli[inmem]`                                        |
| Docker build 失敗 (Apple Silicon) | 安裝 Docker Buildx，使用 `--platform linux/amd64`                  |
| Studio 無法連接                   | 確認 `--no-browser` 未啟用，或手動訪問 `http://localhost:2024`     |
| 認證後 Studio 無法訪問            | 設置 `disable_studio_auth: "false"` 或使用 `is_studio_user()` 判斷 |

---

## 14. 相關資源

- **官方文檔**: https://docs.langchain.com/langsmith/cli
- **API 參考**: https://reference.langchain.com/python/langgraph-cli
- **GitHub**: https://github.com/langchain-ai/langgraph
- **LangGraph Academy**: 免費課程，涵蓋 state、memory、human-in-the-loop

---

## 版本歷史摘要

| 版本    | 日期    | 重要變更                     |
| ------- | ------- | ---------------------------- |
| 0.4.x   | 2026-03 | 新增 `langgraph deploy` 命令 |
| 0.2.11+ | 2025-12 | 支援 `image_distro: wolfi`   |
| 0.1.55+ | 2024-11 | `langgraph dev` 開發模式     |
