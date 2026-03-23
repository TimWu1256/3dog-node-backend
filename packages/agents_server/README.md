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
render_node     — POST to craft3d /render → GLB + PNG snapshot
  ↓
review_node     — Gemini reviews the snapshot image
  ↓
review_router ──┬── (approved or max 5 revisions) → END
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

### Artifact

Each iteration produces an `Artifact` with:
- `version` — monotonically increasing string counter
- `code` — generated TypeScript source
- `glb` — rendered GLB binary
- `snapshot` — PNG snapshot grid (16 views)
- `errors` — list of accumulated error messages
- `review` — `Review(approved, comment)` from Gemini

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

# Optional: override craft3d render endpoint (default: http://localhost:3601/render)
RENDER_GLB_URL=http://localhost:3601/render

# Optional: LangSmith tracing
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=your-langsmith-key
```

### Running with LangGraph CLI

```bash
# Development mode (hot-reload, Studio UI at http://localhost:2024)
langgraph dev

# Production mode (requires Docker)
langgraph up
```

The `craft3d` graph is exposed as an assistant. Call it via the LangGraph SDK or Studio UI with:

```json
{
  "input": {
    "object_name": "torus knot",
    "object_description": "A blue metallic torus knot with roughness 0.2"
  }
}
```

### Direct Python Usage

```python
import asyncio
from agents.src.common.schemas import ObjectProps
from agents.src.graphs.craft3d.graph import invoke_craft3d_agent

async def main():
    result = await invoke_craft3d_agent(
        ObjectProps(object_name="torus knot", object_description="blue metallic")
    )
    artifact = result["current_artifact"]
    print(f"Approved: {artifact.review.approved}")
    print(f"Revisions: {result['revise_count']}")
    # artifact.glb  → bytes (GLB binary)
    # artifact.snapshot → bytes (PNG grid)

asyncio.run(main())
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
