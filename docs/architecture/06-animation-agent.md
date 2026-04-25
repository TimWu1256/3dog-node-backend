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
  -> orchestrator writes csharp_url + planner_class_name back to subagent_result / animation_result
  -> Unity server imports GLB and fetches csharp_url
```

If `animation_enabled` is false, the Animation Agent is skipped and Craft3D
object generation still completes normally.

If Animation Agent fails, object generation still completes. The failure is
recorded in `animation_result.failure_reason`.

## LLM

The Animation Agent uses OpenAI. Model and reasoning effort are configurable via environment variables.

| Env var | Default | Description |
|---------|---------|-------------|
| `ANIMATION_AGENT_MODEL` | `gpt-5.4` | OpenAI model ID |
| `ANIMATION_AGENT_REASONING_EFFORT` | `medium` | Reasoning effort (`low` / `medium` / `high`) |

## Tool server contract

Default paths are configurable with environment variables.

```text
GET  /jobs/:id
GET  /jobs/:id/code      # Craft3D JavaScript/Three.js source used to build the GLB
GET  /jobs/:id/snapshot
POST /jobs/:id/csharp
GET  /jobs/:id/csharp
```

The upload body is plain text (`Content-Type: text/plain; charset=utf-8`):

```
using System.Collections; ...
```

The C# GET response is also plain text.

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
- Start playback in `OnEnable` and stop in `OnDisable`.
- Use `IEnumerator` coroutines for all time-based behaviour.
- Resolve child parts with `Transform part = Part("semantic_hint");`.
- Use `PlannerAnimationActions` and `PlannerTimeline`.
- Avoid scene-wide operations, file/network IO, reflection, threads, and UnityEditor APIs.

Available actions (all `IEnumerator`):

```
PlannerAnimationActions.Wait(float seconds)
PlannerAnimationActions.MoveLocal(Transform target, Vector3 offset, float seconds)
PlannerAnimationActions.MoveWorld(Transform target, Vector3 offset, float seconds)
PlannerAnimationActions.RotateLocal(Transform target, Vector3 eulerOffset, float seconds)
PlannerAnimationActions.SwingLocal(Transform target, Vector3 eulerAmplitude, float seconds, float cycles)
PlannerAnimationActions.ScaleLocal(Transform target, Vector3 scaleMultiplier, float seconds)
PlannerAnimationActions.PlayEffect(Transform emitter, string effectType, float rangeMeters, float intensity, float seconds)
PlannerAnimationActions.FireBreath(Transform emitter, float rangeMeters, float seconds, float headSwingDegrees, Transform swingTarget)
PlannerTimeline.Sequence(params IEnumerator[] actions)
PlannerTimeline.ParallelWaitAll(MonoBehaviour owner, params IEnumerator[] actions)
PlannerTimeline.Repeat(int count, Func<IEnumerator> actionFactory)
PlannerTimeline.Loop(Func<IEnumerator> actionFactory)
```

Valid `effectType` values: `fire`, `beam`, `explosion`, `trail`, `smoke`, `sparks`, `shockwave`, `poison`, `ice`, `electric`, `magic`, `dust`.

Method units:

- `seconds`: seconds as `float`.
- `cycles`: oscillation count as `float`.
- `eulerOffset` / `eulerAmplitude`: degrees as `Vector3`.
- `rangeMeters`: meters as `float`.
- `intensity`: multiplier, usually `0.1f` to `3f`.

The detailed runtime API lives in the Unity server repo beside the planner
runtime source files.
