"""Node functions and LLM helpers for the animation_agent graph."""

from __future__ import annotations

import re

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage

from agents_server.common.model_router import get_chat_model
from agents_server.common.tool_server_client import (
    ToolServerAnimationBundle,
    upload_csharp_planner,
)
from agents_server.graphs.animation_agent.state import AnimationAgentState, PlannerSource

_DEFAULT_ANIMATION_MODEL = "google/gemini-3-flash-preview"

_animation_models: dict[str, BaseChatModel] = {}


def _get_animation_model(model_name: str | None = None, reasoning: str | None = None) -> BaseChatModel:
    name = model_name or _DEFAULT_ANIMATION_MODEL
    cache_key = f"{name}:{reasoning or ''}"
    if cache_key not in _animation_models:
        _animation_models[cache_key] = get_chat_model(
            name,
            openai_kwargs={"reasoning_effort": reasoning or "medium"},
            google_kwargs={"thinking_level": reasoning or "low"},
        )
    return _animation_models[cache_key]

ANIMATION_AGENT_SYSTEM_PROMPT = ("""
You are the Mind Reality Animation Agent.

You receive a Craft3D object snapshot, generated Three.js code, object name,
and original user request. Generate exactly one Unity C# runtime planner script.

Output rules:
- Return plain C# source only.
- Do not return JSON.
- Do not use markdown fences.
- Do not include notes, explanations, or comments outside the C# file.
- No namespace.
- Exactly one public sealed class deriving from RuntimeGeneratedPlanner.
- The class should start playback in OnEnable and stop playback in OnDisable.
- Use IEnumerator coroutines for all time-based behavior.

Available Unity server types:
- RuntimeGeneratedPlanner is already compiled in the Unity server assembly.
- PlannerAnimationActions is already compiled in the Unity server assembly.
- PlannerTimeline is already compiled in the Unity server assembly.
- These classes are in the global namespace. Do not import them with a namespace.
- Use only `using System;`, `using System.Collections;`, and `using UnityEngine;`.

Available C# helper API and units:
- Call every helper below directly, with NO class prefix. They are inherited
  protected methods on RuntimeGeneratedPlanner. Do NOT write
  `PlannerAnimationActions.` or `PlannerTimeline.` before them.
- Do NOT invent helpers (for example `SpawnEffect`). Use ONLY the methods listed here.
- `Transform Part(string partHint)` resolves a GLB child by semantic hint.
- `IEnumerator Wait(float seconds)`.
- `IEnumerator MoveLocal(Transform target, Vector3 offset, float seconds)`.
- `IEnumerator MoveWorld(Transform target, Vector3 offset, float seconds)`.
- `IEnumerator RotateLocal(Transform target, Vector3 eulerOffset, float seconds)`.
- `IEnumerator SwingLocal(Transform target, Vector3 eulerAmplitude, float seconds, float cycles)`.
- `IEnumerator ScaleLocal(Transform target, Vector3 scaleMultiplier, float seconds)`.
- `IEnumerator Sequence(params IEnumerator[] actions)`.
- `IEnumerator ParallelWaitAll(params IEnumerator[] actions)`.
- `IEnumerator Repeat(int count, Func<IEnumerator> actionFactory)`.
- `IEnumerator Loop(Func<IEnumerator> actionFactory)`.

Units and values:
- `seconds` is seconds, as a float like `2.5f`.
- `cycles` is the number of oscillation cycles, as a float like `3f`.
- `eulerOffset` and `eulerAmplitude` are degrees, as `Vector3`.
- `rangeMeters` is meters, as a float.
- `intensity` is a multiplier. Prefer `0.1f` to `3f`.

Safety rules:
- Do not use System.IO, System.Net, System.Diagnostics, System.Reflection, UnityEditor, DllImport, unsafe, async, await, Thread, Task, Process, File, Directory, SceneManager, Application.Quit, GameObject.Find, FindObjectOfType, or AddComponent.
- Control only `transform` and child Transforms resolved via `Part(...)`.
""".strip())


# ---------------------------------------------------------------------------
# LLM call
# ---------------------------------------------------------------------------


async def _generate_runtime_planner(
    bundle: ToolServerAnimationBundle,
    *,
    model_name: str | None = None,
    reasoning: str | None = None,
) -> PlannerSource:
    class_name = _safe_class_name(bundle.object_name, bundle.job_id)
    prompt = _build_animation_prompt(bundle, class_name)

    response = await _get_animation_model(model_name, reasoning).ainvoke([
        SystemMessage(content=ANIMATION_AGENT_SYSTEM_PROMPT),
        HumanMessage(content=[
            {"type": "text", "text": prompt},
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:{bundle.snapshot_mime_type};base64,{bundle.snapshot_base64}",
                },
            },
        ]),
    ])

    raw_content = response.content
    if isinstance(raw_content, str):
        raw = raw_content
    elif isinstance(raw_content, list):
        raw = "\n".join(
            item.get("text", "") if isinstance(item, dict) else str(item)
            for item in raw_content
            if not (isinstance(item, dict) and item.get("type") == "thinking")
        )
    else:
        raw = ""

    csharp = _sanitize_csharp_for_upload(raw)
    _validate_generated_csharp(csharp)
    return PlannerSource(
        class_name=_class_name_from_csharp(csharp) or class_name,
        csharp=csharp,
    )


# ---------------------------------------------------------------------------
# Graph nodes
# ---------------------------------------------------------------------------


async def generate(state: AnimationAgentState) -> dict:
    bundle = state["bundle"]
    try:
        planner = await _generate_runtime_planner(
            bundle,
            model_name=state.get("model"),
            reasoning=state.get("reasoning"),
        )
        return {"planner": planner}
    except Exception as exc:
        return {"failure_reason": f"{type(exc).__name__}: {exc}"}


async def save(state: AnimationAgentState) -> dict:
    planner = state.get("planner")
    if planner is None:
        return {}
    try:
        upload = await upload_csharp_planner(job_id=state["job_id"], csharp=planner.csharp)
        return {
            "csharp_url": upload.csharp_url,
            "planner_class_name": planner.class_name,
        }
    except Exception as exc:
        return {"failure_reason": f"{type(exc).__name__}: {exc}"}


# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------


def _build_animation_prompt(bundle: ToolServerAnimationBundle, class_name: str) -> str:
    return f"""
Create a runtime Unity C# planner for this Craft3D object.

Object name:
{bundle.object_name}

Object description:
{bundle.object_description}

Preferred class name:
{class_name}

Craft3D generated Three.js code:
```js
{bundle.code}
```

Use the snapshot and code to infer useful semantic parts such as head, mouth,
wing, tail, hand, weapon, root, body, and emitter points. If an exact part is not
obvious, use the closest semantic hint and let `Part(...)` resolve it at runtime.
If the code is long, prioritize hierarchy, names, transforms, exporter usage,
and semantically meaningful child parts over boilerplate.
""".strip()


def _sanitize_csharp_for_upload(text: str) -> str:
    cleaned = _strip_outer_fences(text).strip()
    fenced = _extract_fenced_code(cleaned)
    if fenced:
        cleaned = _strip_outer_fences(fenced).strip()

    cleaned = _trim_to_csharp(cleaned)
    cleaned = _strip_outer_fences(cleaned).strip()

    if "```" in cleaned or "'''" in cleaned:
        raise ValueError("Planner C# still contains markdown/code fence markers.")

    return cleaned


def _strip_outer_fences(text: str) -> str:
    stripped = text.strip()
    for fence in ("```", "'''"):
        if stripped.startswith(fence):
            stripped = re.sub(
                rf"^{re.escape(fence)}[a-zA-Z0-9_#+-]*\s*",
                "",
                stripped,
            )
            stripped = re.sub(rf"\s*{re.escape(fence)}$", "", stripped)
    return stripped.strip()


def _extract_fenced_code(text: str) -> str | None:
    pattern = re.compile(
        r"```(?P<lang>[a-zA-Z0-9_#+-]*)\s*\n(?P<code>[\s\S]*?)```"
        r"|'''(?P<slang>[a-zA-Z0-9_#+-]*)\s*\n(?P<scode>[\s\S]*?)'''",
        re.MULTILINE,
    )
    matches = list(pattern.finditer(text))
    if not matches:
        return None

    def score(match: re.Match) -> int:
        lang = (match.group("lang") or match.group("slang") or "").lower()
        if lang in {"csharp", "cs", "c#", "c-sharp"}:
            return 3
        if not lang:
            return 2
        return 1

    best = max(matches, key=score)
    return best.group("code") or best.group("scode")


def _trim_to_csharp(text: str) -> str:
    starts = [
        idx
        for idx in (
            text.find("using System;"),
            text.find("using System.Collections"),
            text.find("using UnityEngine"),
            text.find("public sealed class"),
        )
        if idx >= 0
    ]
    if not starts:
        return text.strip()
    return text[min(starts) :].strip()


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------


def _validate_generated_csharp(csharp: str) -> None:
    if not csharp:
        raise ValueError("Animation Agent returned empty C#.")

    blocked_tokens = (
        "System.IO",
        "System.Net",
        "System.Diagnostics",
        "System.Reflection",
        "UnityEditor",
        "DllImport",
        "unsafe",
        "async ",
        "await ",
        "Thread",
        "Task",
        "Process",
        "File.",
        "Directory.",
        "SceneManager",
        "Application.Quit",
        "GameObject.Find",
        "FindObjectOfType",
        "AddComponent",
    )
    for token in blocked_tokens:
        if token in csharp:
            raise ValueError(f"Generated planner contains blocked token: {token}")

    class_matches = re.findall(
        r"\bpublic\s+sealed\s+class\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*RuntimeGeneratedPlanner\b",
        csharp,
    )
    if len(class_matches) != 1:
        raise ValueError(
            "Generated planner must contain exactly one public sealed class deriving "
            "from RuntimeGeneratedPlanner."
        )
    if "IEnumerator" not in csharp:
        raise ValueError("Generated planner must use IEnumerator coroutine actions.")
    if re.search(r"\bnamespace\s+[A-Za-z_][A-Za-z0-9_.]*", csharp):
        raise ValueError("Generated planner must not declare a namespace.")


# ---------------------------------------------------------------------------
# Name helpers
# ---------------------------------------------------------------------------


def _class_name_from_csharp(csharp: str) -> str | None:
    match = re.search(r"\bclass\s+([A-Za-z_][A-Za-z0-9_]*)", csharp)
    return match.group(1) if match else None


def _safe_class_name(object_name: str, job_id: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", object_name or "GeneratedObject")
    name = "".join(word[:1].upper() + word[1:] for word in words) or "GeneratedObject"
    if name[0].isdigit():
        name = "Generated" + name

    suffix = re.sub(r"[^A-Za-z0-9]", "", job_id or "")[:8]
    return f"{name}RuntimePlanner{suffix}"
