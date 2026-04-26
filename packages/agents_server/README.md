# agents_server

LangGraph-based agentic system for generating 3D objects from natural language descriptions, powered by Google Gemini and OpenAI, using the [craft3d](../../services/craft3d) rendering service.

## Architecture

```
packages/agents_server/
├── src/agents_server/
│   ├── common/
│   │   ├── schemas.py              # ObjectProps input model
│   │   ├── render_client.py        # HTTP client for craft3d /render endpoint
│   │   ├── tool_server_client.py   # HTTP client for craft3d tool-server endpoints (code, snapshot, csharp)
│   │   ├── instructions.py         # Jinja2 prompt template loader
│   │   └── utils.py                # Code extraction and error helpers
│   └── graphs/
│       ├── orchestrator/
│       │   ├── graph.py            # StateGraph assembly
│       │   ├── state.py            # OrchestratorState, SubagentResult, AnimationAgentResult
│       │   ├── nodes.py            # record_event, invoke_craft3d, invoke_animation_agent
│       │   └── edges.py            # event_router, TOOL_DISPATCH
│       ├── craft3d/
│       │   ├── graph.py            # StateGraph assembly
│       │   ├── state.py            # Craft3DState, Artifact, reducers
│       │   ├── nodes.py            # craft, render, review, revise
│       │   └── edges.py            # review_router conditional edge
│       └── animation_agent/
│           ├── graph.py            # StateGraph assembly
│           ├── state.py            # AnimationAgentState, PlannerSource, AnimationPlannerResult
│           └── nodes.py            # generate, save; system prompt and C# sanitiser
├── langgraph.json
├── pyproject.toml
└── .env
```

---

## Graph: `orchestrator`

Context manager for a Unity Realtime API session. Persists across all runs on a thread (one thread = one session).

```
START → record_event → [event_router]
                            ├─ tool_call "create_3d_object" → invoke_craft3d → [_after_craft3d]
                            │                                                       ├─ craft3d 成功 → invoke_animation_agent → END
                            │                                                       └─ 否則 ─────────────────────── END
                            └─ 其他事件 ────────────────────────────────────────────────────────────────────────────────────────────────────── END
```

### State (`OrchestratorState`)

| Field | Type | Description |
|---|---|---|
| `events` | `Annotated[list, append]` | Full session event log, accumulated across all runs |
| `current_event` | `dict \| None` | Input event for the current run |
| `subagent_result` | `dict \| None` | `{ job_id, glb_url, csharp_url, failure_reason }` — Unity reads this |
| `animation_result` | `dict \| None` | `{ job_id, csharp_ready, csharp_url, planner_class_name, failure_reason }` — audit detail |

Unity reads `GET /threads/{id}/state` to get `subagent_result` (and optionally `animation_result`) after a `tool_call` run.

---

## Graph: `craft3d`

Iterative refinement loop: generates Three.js TypeScript code from a text description, renders it to GLB, and reviews the PNG snapshot. Invoked by orchestrator as a sub-agent.

```
START → craft → render → review → review_router ──┬── (approved or max revisions) → END
                   ↑                               └── revise ──────────────────────┘ (loop)
```

### Models

| Node | Model |
|---|---|
| `craft`, `revise` | Google Gemini (`gemini-3-flash-preview`, `thinking_level: low`) |
| `review` | OpenAI (`gpt-5.4-mini`, `reasoning_effort: low`) |

### State (`Craft3DState`)

| Field | Type | Description |
|---|---|---|
| `input` | `ObjectProps` | Original user request |
| `artifact_history` | `list[Artifact]` | All attempted versions (custom append reducer) |
| `current_version` | `str \| None` | Active artifact version pointer |
| `review_count` | `int` | Total review attempts (accumulates) |
| `job_id` | `str` | Latest successful render job ID |
| `glb_url` | `str` | GLB download URL; empty if no render succeeded |
| `csharp_url` | `str` | C# animation script URL; empty until animation_agent succeeds |
| `failure_reason` | `str \| None` | Set by review on rejection; None on success |

### Output Schema (`Craft3DOutput`)

| Field | Type | Description |
|---|---|---|
| `job_id` | `str` | Empty string if all renders failed |
| `glb_url` | `str` | Full download URL; empty if all renders failed |
| `csharp_url` | `str` | C# animation script URL; empty if animation_agent skipped or failed |
| `failure_reason` | `str \| None` | None on success; last review comment on failure |

> GLB bytes are **not** stored in state. Unity downloads the GLB via `glb_url` directly from craft3d.

---

## Graph: `animation_agent`

Generates a Unity C# runtime planner for a Craft3D object. Invoked by orchestrator after craft3d succeeds. Not exposed as a LangGraph assistant.

```
START → generate → save → END
```

### Model

OpenAI model, configurable via env vars (default `gpt-5.4`, `reasoning_effort: medium`).

### State (`AnimationAgentState`)

| Field | Type | Description |
|---|---|---|
| `job_id` | `str` | Craft3D job ID |
| `bundle` | `ToolServerAnimationBundle` | Fetched artifacts (metadata, Three.js code, snapshot) |
| `planner` | `PlannerSource \| None` | Intermediate: generated C# + class name |
| `csharp_url` | `str` | Uploaded planner URL (output) |
| `planner_class_name` | `str` | Generated class name (output) |
| `failure_reason` | `str \| None` | Error message; None on success |

---

## Getting Started

### Prerequisites

- Python ≥ 3.13
- [uv](https://docs.astral.sh/uv/) package manager
- [craft3d](../../services/craft3d) service running on port `3601`
- `GOOGLE_API_KEY` and `OPENAI_API_KEY` set in `.env`

### Install

```bash
cd packages/agents_server
uv sync
```

### Environment Variables

```env
# LLM API keys
GOOGLE_API_KEY=your-google-api-key
OPENAI_API_KEY=your-openai-api-key

# craft3d service
RENDER_SERVICE_URL=http://localhost:3601
RENDER_GLB_URL=http://localhost:3601/render

# Animation Agent (optional overrides)
ANIMATION_AGENT_MODEL=gpt-5.4
ANIMATION_AGENT_REASONING_EFFORT=medium

# LangSmith tracing (required for LangGraph Studio)
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=your-langsmith-api-key
LANGSMITH_PROJECT=craft3d
```

### Running with LangGraph CLI

```bash
# Development mode (hot-reload), port 3600
uv run langgraph dev --host 0.0.0.0 --port 3600 --no-browser
```

Only `orchestrator` and `craft3d` are exposed as LangGraph assistants. `animation_agent` is internal.

### LangGraph Studio

```
https://smith.langchain.com/studio/?baseUrl=http://localhost:3600
```

---

## Prompt Templates

Loaded from `../../instructions/` via Jinja2:

| Template | Used by |
|---|---|
| `craft3d-generation-v3.md` | `craft` node — initial code generation |
| `craft3d-review.md` | `review` node — snapshot quality review |
| `craft3d-revise.md` | `revise` node — code revision given feedback |

The Animation Agent system prompt is defined inline in `graphs/animation_agent/nodes.py`.
