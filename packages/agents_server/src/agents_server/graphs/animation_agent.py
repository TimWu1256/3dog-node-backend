"""Animation Agent for generating Unity runtime planner C#."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any

import httpx

from agents_server.common.tool_server_client import (
    ToolServerAnimationBundle,
    fetch_animation_bundle,
    upload_csharp_planner,
)


DEFAULT_ANIMATION_MODEL = os.environ.get("ANIMATION_AGENT_MODEL", "gpt-5.4-mini")
DEFAULT_REASONING_EFFORT = os.environ.get("ANIMATION_AGENT_REASONING_EFFORT", "medium")
MAX_CODE_CHARS = int(os.environ.get("ANIMATION_AGENT_MAX_CODE_CHARS", "18000"))
OPENAI_RESPONSES_URL = os.environ.get(
    "OPENAI_RESPONSES_URL",
    f"{os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1').rstrip('/')}/responses",
)


@dataclass(frozen=True)
class AnimationPlannerResult:
    job_id: str
    csharp_ready: bool = False
    csharp_url: str = ""
    planner_class_name: str = ""
    failure_reason: str | None = None

    @property
    def is_success(self) -> bool:
        return self.csharp_ready and not self.failure_reason

    def model_dump(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "csharp_ready": self.csharp_ready,
            "csharp_url": self.csharp_url,
            "planner_class_name": self.planner_class_name,
            "failure_reason": self.failure_reason,
        }


@dataclass(frozen=True)
class PlannerSource:
    class_name: str
    csharp: str


async def run_animation_agent(
    *,
    job_id: str,
    object_name: str,
    object_description: str,
    user_prompt: str,
) -> AnimationPlannerResult:
    """Generate a planner and upload it to the tool server.

    Failure is returned as data so Craft3D object creation can still succeed.
    """

    if not job_id:
        return AnimationPlannerResult(job_id="", failure_reason="Missing Craft3D job_id.")

    try:
        bundle = await fetch_animation_bundle(
            job_id=job_id,
            object_name=object_name,
            object_description=object_description,
            user_prompt=user_prompt,
        )
        planner = await generate_runtime_planner(bundle)
        upload = await upload_csharp_planner(job_id=job_id, csharp=planner.csharp)
        return AnimationPlannerResult(
            job_id=job_id,
            csharp_ready=True,
            csharp_url=upload.csharp_url,
            planner_class_name=planner.class_name,
        )
    except Exception as exc:
        return AnimationPlannerResult(
            job_id=job_id,
            failure_reason=f"{type(exc).__name__}: {exc}",
        )


async def generate_runtime_planner(bundle: ToolServerAnimationBundle) -> PlannerSource:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required for Animation Agent.")

    class_name = _safe_class_name(bundle.object_name, bundle.job_id)
    prompt = _build_animation_prompt(bundle, class_name)

    request_json = {
        "model": DEFAULT_ANIMATION_MODEL,
        "reasoning": {"effort": DEFAULT_REASONING_EFFORT},
        "input": [
            {
                "role": "system",
                "content": [
                    {
                        "type": "input_text",
                        "text": ANIMATION_AGENT_SYSTEM_PROMPT,
                    }
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {
                        "type": "input_image",
                        "image_url": (
                            f"data:{bundle.snapshot_mime_type};base64,"
                            f"{bundle.snapshot_base64}"
                        ),
                    },
                ],
            },
        ],
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if organization := os.environ.get("OPENAI_ORG_ID"):
        headers["OpenAI-Organization"] = organization
    if project := os.environ.get("OPENAI_PROJECT_ID"):
        headers["OpenAI-Project"] = project

    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(OPENAI_RESPONSES_URL, headers=headers, json=request_json)
        if response.status_code >= 400:
            raise RuntimeError(
                f"OpenAI Responses API failed HTTP {response.status_code}: "
                f"{response.text[:600]}"
            )
        response_json = response.json()

    csharp = _sanitize_csharp_for_upload(_extract_response_text(response_json))
    _validate_generated_csharp(csharp)
    return PlannerSource(
        class_name=_class_name_from_csharp(csharp) or class_name,
        csharp=csharp,
    )


ANIMATION_AGENT_SYSTEM_PROMPT = """
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
- Prefer stable looping behavior for idle, magical, elemental, fire, or electric effects unless the user clearly requests a one-shot action.

Available Unity server types:
- RuntimeGeneratedPlanner is already compiled in the Unity server assembly.
- PlannerAnimationActions is already compiled in the Unity server assembly.
- PlannerTimeline is already compiled in the Unity server assembly.
- These classes are in the global namespace. Do not import them with a namespace.
- Use only `using System;`, `using System.Collections;`, and `using UnityEngine;`.

Available C# helper API and units:
- `Transform Part(string partHint)` resolves a GLB child by semantic hint.
- `IEnumerator Wait(float seconds)` waits for seconds.
- `IEnumerator PlannerAnimationActions.Wait(float seconds)`.
- `IEnumerator PlannerAnimationActions.MoveLocal(Transform target, Vector3 offset, float seconds)`.
- `IEnumerator PlannerAnimationActions.MoveWorld(Transform target, Vector3 offset, float seconds)`.
- `IEnumerator PlannerAnimationActions.RotateLocal(Transform target, Vector3 eulerOffset, float seconds)`.
- `IEnumerator PlannerAnimationActions.SwingLocal(Transform target, Vector3 eulerAmplitude, float seconds, float cycles)`.
- `IEnumerator PlannerAnimationActions.ScaleLocal(Transform target, Vector3 scaleMultiplier, float seconds)`.
- `IEnumerator PlannerAnimationActions.PlayEffect(Transform emitter, string effectType, float rangeMeters, float intensity, float seconds)`.
- `IEnumerator PlannerAnimationActions.FireBreath(Transform emitter, float rangeMeters, float seconds, float headSwingDegrees, Transform swingTarget)`.
- `IEnumerator PlannerTimeline.Sequence(params IEnumerator[] actions)`.
- `IEnumerator PlannerTimeline.ParallelWaitAll(MonoBehaviour owner, params IEnumerator[] actions)`.
- `IEnumerator PlannerTimeline.Repeat(int count, Func<IEnumerator> actionFactory)`.
- `IEnumerator PlannerTimeline.Loop(Func<IEnumerator> actionFactory)`.

Units and values:
- `seconds` is seconds, as a float like `2.5f`.
- `cycles` is the number of oscillation cycles, as a float like `3f`.
- `eulerOffset` and `eulerAmplitude` are degrees, as `Vector3`.
- `rangeMeters` is meters, as a float.
- `intensity` is a multiplier. Prefer `0.1f` to `3f`.
- Effects must use one of: `fire`, `beam`, `explosion`, `trail`, `smoke`, `sparks`, `shockwave`, `poison`, `ice`, `electric`, `magic`, `dust`.

Safety rules:
- Do not use System.IO, System.Net, System.Diagnostics, System.Reflection, UnityEditor, DllImport, unsafe, async, await, Thread, Task, Process, File, Directory, SceneManager, Application.Quit, GameObject.Find, FindObjectOfType, or AddComponent.
- Control only `transform` and child Transforms resolved via `Part(...)`.
""".strip()


def _build_animation_prompt(bundle: ToolServerAnimationBundle, class_name: str) -> str:
    code = _truncate(bundle.code, MAX_CODE_CHARS)
    metadata = str(bundle.job_metadata)[:4000]

    return f"""
Create a runtime Unity C# planner for this Craft3D object.

Object name:
{bundle.object_name}

Object description:
{bundle.object_description}

Original user request:
{bundle.user_prompt}

Preferred class name:
{class_name}

Tool server job metadata:
{metadata}

Craft3D generated Three.js code:
```ts
{code}
```

Use the snapshot and code to infer useful semantic parts such as head, mouth,
wing, tail, hand, weapon, root, body, and emitter points. If an exact part is not
obvious, use the closest semantic hint and let `Part(...)` resolve it at runtime.
""".strip()


def _extract_response_text(response: dict[str, Any]) -> str:
    output_text = response.get("output_text")
    if output_text:
        return str(output_text)

    chunks: list[str] = []
    for item in response.get("output", []) or []:
        for content in item.get("content", []) or []:
            text = content.get("text")
            if text is not None:
                chunks.append(str(text))
    return "\n".join(chunks)


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


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n// ... truncated for Animation Agent context ..."
