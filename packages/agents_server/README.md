# agents

LangGraph-based agentic system for generating 3D objects from natural language descriptions, powered by Google Gemini and the [craft3d](../../services/craft3d) rendering service.

## Architecture

```
packages/agents/
├── src/
│   ├── common/
│   │   ├── schemas.py          # ObjectProps input model
│   │   ├── render_client.py    # HTTP client for craft3d /render endpoint
│   │   ├── instructions.py     # Jinja2 prompt template loader
│   │   └── utils.py            # Code extraction and error helpers
│   └── graphs/
│       └── craft3d/
│           ├── graph.py        # StateGraph assembly + public entrypoint
│           ├── state.py        # Craft3DState TypedDict, Artifact, reducers
│           ├── nodes.py        # craft_node, render_node, review_node, revise_node
│           └── edges.py        # review_router conditional edge
├── langgraph.json              # LangGraph CLI config
├── pyproject.toml
└── .env                        # Environment variables (not committed)
```

## Graph: `craft3d`

A four-node iterative refinement loop:

```
START
  ↓
craft_node      — Gemini generates Three.js TypeScript code
  ↓
render_node     — POST to craft3d /render → PNG snapshot + job_id; sets glb_url
  ↓
review_node     — Gemini reviews the snapshot image
  ↓
review_router ──┬── (approved or max 2 revisions) → END
                └── revise_node (Gemini revises the code)
                      ↓
                    render_node  (loop)
```

### State (`Craft3DState`)

| Field | Type | Description |
|---|---|---|
| `input` | `ObjectProps` | Original user request |
| `artifact_history` | `list[Artifact]` | All attempted versions (append-only) |
| `current_version` | `str \| None` | Active artifact version pointer |
| `revise_count` | `int` | Total revision attempts (accumulates) |
| `job_id` | `str` | Latest successful render job ID (empty if none) |
| `glb_url` | `str` | GLB download URL set by `render_node` on success |
| `failure_reason` | `str \| None` | Set by `review_node`; None when approved |

### Output Schema (`Craft3DOutput`)

What `/runs/wait` and stream endpoints return to clients (does not affect internal state):

| Field | Type | Description |
|---|---|---|
| `job_id` | `str` | Empty string if all renders failed |
| `glb_url` | `str` | Full download URL; empty string if all renders failed |
| `failure_reason` | `str \| None` | None on success; last review comment on failure |

### Artifact

Each iteration produces an `Artifact` with:
- `version` — monotonically increasing string counter
- `code` — generated TypeScript source
- `snapshot` — PNG snapshot grid (16 views); serialised as base64 in JSON
- `errors` — list of accumulated error messages
- `review` — `Review(approved, comment)` from Gemini
- `job_id` — render service job ID (empty if render failed)

> GLB bytes are **not** stored in state. Unity downloads the GLB via `glb_url` from the craft3d service directly.

## Getting Started

### Prerequisites

- Python ≥ 3.13
- [uv](https://docs.astral.sh/uv/) package manager
- [craft3d](../../services/craft3d) service running on port `3601`
- `GOOGLE_API_KEY` set in `.env`

### Install

```bash
cd packages/agents_server
uv sync
```

### Environment Variables

Create a `.env` file:

```env
GOOGLE_API_KEY=your-google-api-key

# craft3d render endpoint
RENDER_GLB_URL=http://localhost:3601/render

# LangSmith tracing (required for LangGraph Studio)
LANGSMITH_TRACING=true
LANGSMITH_ENDPOINT=https://api.smith.langchain.com
LANGSMITH_API_KEY=your-langsmith-api-key
LANGSMITH_PROJECT="craft3d"
```

### Running with LangGraph CLI

```bash
# Development mode (hot-reload), served on port 3600
langgraph dev --port 3600

# Production mode (requires Docker)
langgraph up
```

### Monitoring with LangGraph Studio

Open the Studio UI in your browser:

```
https://smith.langchain.com/studio/?baseUrl=http://localhost:3600
```

Studio provides:
- Real-time graph visualization with per-node execution status
- Full state history and diffs at each step
- Ability to replay or fork any past run

> Requires a LangSmith account with `LANGSMITH_API_KEY` configured in `.env`.

The `craft3d` graph is exposed as an assistant. Call it via the LangGraph SDK or Studio UI with:

```json
{
  "input": {
    "object_name": "torus knot",
    "object_description": "A blue metallic torus knot with roughness 0.2"
  }
}
```

### Direct Python Usage (development / testing)

```python
import asyncio
from agents_server.common.schemas import ObjectProps
from agents_server.graphs.craft3d.graph import craft3d_agent
from agents_server.graphs.craft3d.state import Craft3DState

async def main():
    initial: Craft3DState = {
        "input": ObjectProps(object_name="torus knot", object_description="blue metallic"),
        "artifact_history": [],
        "current_version": None,
        "revise_count": 0,
        "job_id": "",
        "glb_url": "",
        "failure_reason": None,
    }
    result = await craft3d_agent.ainvoke(initial)
    print(f"glb_url: {result['glb_url']}")
    print(f"failure_reason: {result['failure_reason']}")

asyncio.run(main())
```

Or use `run_test.py` directly:

```bash
uv run python src/agents_server/graphs/craft3d/run_test.py
```

## Integration with craft3d

The agents call `POST /render` on the craft3d service:

**Request:**
```json
{ "code": "<Three.js TypeScript>", "timeoutSec": 60 }
```

**Success response:**
```json
{ "success": true, "job_id": "...", "glb": "<base64>", "snapshot": "<base64>" }
```

**Failure response:**
```json
{ "success": false, "error": "ReferenceError: ..." }
```

The render client (`src/common/render_client.py`) decodes the base64 fields back to `bytes`.

## Prompt Templates

Prompts are loaded from `../../instructions/` via Jinja2:

| Template | Used by |
|---|---|
| `threejs-generation-v2.md` | `craft_node` — initial code generation |
| `craft3d-review.md` | `review_node` — snapshot quality review |
| `craft3d-revise.md` | `revise_node` — code revision given feedback |

## LLM

Both the craft and review models use **Gemini 3.1 Pro (preview)** with `thinking_level: LOW`.
Configure via `GOOGLE_API_KEY` in `.env`.
