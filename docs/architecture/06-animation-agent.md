# Animation Agent Backend Handoff

This document records the backend side of the runtime animation planner flow.
The Unity server remains the source of truth for planner runtime APIs.

## Flow

```text
create_3d_object(animation_enabled=true)
  -> orchestrator.invoke_craft3d
  -> craft3d returns job_id + glb_url
  -> orchestrator.invoke_animation_agent
  -> Animation Agent fetches /jobs/:id, /jobs/:id/code, /jobs/:id/snapshot
  -> Animation Agent asks OpenAI for one plain C# planner file
  -> backend POSTs { animation_csharp } to /jobs/:id/csharp
  -> orchestrator writes csharp_url back to subagent_result
  -> Unity server imports GLB and fetches csharp_url
```

If `animation_enabled` is false, the Animation Agent is skipped and Craft3D
object generation still completes normally.

If Animation Agent fails, object generation still completes. The failure is
recorded in `animation_result.failure_reason`.

## Tool server contract

Default paths are configurable with environment variables.

```text
GET  /jobs/:id
GET  /jobs/:id/code      # Craft3D JavaScript/Three.js source used to build the GLB
GET  /jobs/:id/snapshot
POST /jobs/:id/csharp
GET  /jobs/:id/csharp
```

The upload body is:

```json
{ "animation_csharp": "using System.Collections; ..." }
```

The C# GET response includes a compatibility alias only for C# naming:

```json
{
  "animation_csharp": "...",
}
```

Do not use `code` for C# planner source. In this backend, `code` means the
Craft3D JavaScript/Three.js source returned by `GET /jobs/:id/code`.

## OpenAI output contract

The Animation Agent prompt asks the model to return plain C# only.

Do not ask the model to wrap C# inside JSON. C# source contains braces, quotes,
and newlines, so JSON wrapping creates avoidable escaping failures.

The backend still strips accidental Markdown fences before upload.

## Unity planner contract summary

Generated code should:

- Use `using System;`, `using System.Collections;`, and `using UnityEngine;`.
- Define exactly one `public sealed class ... : RuntimeGeneratedPlanner`.
- Use `IEnumerator` coroutines.
- Resolve child parts with `Transform part = Part("semantic_hint");`.
- Use `PlannerAnimationActions` and `PlannerTimeline`.
- Avoid scene-wide operations, file/network IO, reflection, threads, and UnityEditor APIs.

Method units are explicit in the Animation Agent prompt:

- `seconds`: seconds as `float`.
- `cycles`: oscillation count as `float`.
- `eulerOffset` / `eulerAmplitude`: degrees as `Vector3`.
- `rangeMeters`: meters as `float`.
- `intensity`: multiplier, usually `0.1f` to `3f`.

The detailed runtime API lives in the Unity server repo beside the planner
runtime source files.
