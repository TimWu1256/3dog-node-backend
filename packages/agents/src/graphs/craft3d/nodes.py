"""
Node functions for the craft3d graph.
Each node is a plain async function: (state) -> partial state update dict.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import Any

from langchain_core.messages import HumanMessage
from langchain_google_genai import ChatGoogleGenerativeAI

from agents.src.common.instructions import load_instructions_template
from agents.src.common.render_client import RenderGlbError, render_glb
from agents.src.common.utils import extract_code_from_markdown, stringify_error
from agents.src.graphs.craft3d.state import (
    Artifact,
    Craft3DState,
    Review,
    get_current_artifact,
    replace_artifact_in_history,
)

log = logging.getLogger("graphs.craft3d")

# ---------------------------------------------------------------------------
# Prompt templates (loaded once at import time)
# ---------------------------------------------------------------------------

_render_generation_prompt = load_instructions_template("threejs-generation-v2")
_render_review_prompt = load_instructions_template("craft3d-review")
_render_revise_prompt = load_instructions_template("craft3d-revise")

# ---------------------------------------------------------------------------
# LLM clients (lazy-initialized to defer API key validation until first use)
# ---------------------------------------------------------------------------

_craft_model: ChatGoogleGenerativeAI | None = None
_review_model: ChatGoogleGenerativeAI | None = None


def _get_craft_model() -> ChatGoogleGenerativeAI:
    global _craft_model
    if _craft_model is None:
        _craft_model = ChatGoogleGenerativeAI(
            model="gemini-3.1-pro-preview",
            thinking_config={"thinking_level": "LOW"},  # type: ignore[call-arg]
        )
    return _craft_model


def _get_review_model() -> ChatGoogleGenerativeAI:
    global _review_model
    if _review_model is None:
        _review_model = ChatGoogleGenerativeAI(
            model="gemini-3.1-pro-preview",
            thinking_config={"thinking_level": "LOW"},  # type: ignore[call-arg]
        )
    return _review_model

# ---------------------------------------------------------------------------
# Debug persistence
# ---------------------------------------------------------------------------


async def _debug_save_artifact(artifact: Artifact) -> None:
    from pathlib import Path

    name = f"{time.time_ns()}_{artifact.input.object_name}_{artifact.version}"
    base = Path("./out") / name
    base.mkdir(parents=True, exist_ok=True)

    meta = {"props": artifact.input.model_dump(), "errors": artifact.errors}
    (base / "meta.txt").write_text(json.dumps(meta))
    if artifact.code:
        (base / "code.txt").write_text(artifact.code)
    if artifact.glb:
        (base / "output.glb").write_bytes(artifact.glb)
    if artifact.snapshot:
        (base / "snapshot.png").write_bytes(artifact.snapshot)
    if artifact.review:
        (base / "review.txt").write_text(artifact.review.comment)


# ---------------------------------------------------------------------------
# Core artifact operations
# ---------------------------------------------------------------------------


async def _create_artifact(
    *,
    version: str,
    input,  # ObjectProps
    fallback_code: str | None = None,
    additional_content: list[dict[str, Any]] = [],
) -> Artifact:
    try:
        content: list[Any] = [
            {"type": "text", "text": _render_generation_prompt(input.model_dump())},
            *additional_content,
        ]
        response = await _get_craft_model().ainvoke([HumanMessage(content=content)])
        raw: str = response.content if isinstance(response.content, str) else ""
        code = extract_code_from_markdown(raw)
        return Artifact(
            version=version,
            input=input,
            code=(code.strip() if code else None) or fallback_code,
        )
    except Exception as exc:
        return Artifact(
            version=version,
            input=input,
            code=fallback_code,
            errors=[stringify_error(exc)],
        )


async def _render_artifact(artifact: Artifact) -> Artifact:
    if not artifact.code:
        return artifact.copy_with(
            errors=[*artifact.errors, "No code to generate GLB from"]
        )
    try:
        result = await render_glb(artifact.code, timeout_ms=10_000)
        return artifact.copy_with(glb=result.glb, snapshot=result.snapshot)
    except RenderGlbError as exc:
        return artifact.copy_with(errors=[*artifact.errors, str(exc)])
    except Exception as exc:
        return artifact.copy_with(errors=[*artifact.errors, stringify_error(exc)])


async def _review_artifact(artifact: Artifact) -> Artifact:
    error_prefix = (
        "Found error{}:\n\n{}".format(
            "s" if len(artifact.errors) > 1 else "", "\n".join(artifact.errors)
        )
        if artifact.errors
        else None
    )

    if not artifact.snapshot:
        return artifact.copy_with(
            review=Review(
                approved=False,
                comment=error_prefix
                or "The result was not generated correctly due to unexpected reasons.",
            )
        )

    b64 = base64.b64encode(artifact.snapshot).decode()
    data_uri = f"data:image/png;base64,{b64}"

    response = await _get_review_model().ainvoke([
        HumanMessage(content=[
            {"type": "text", "text": _render_review_prompt(artifact.input.model_dump())},
            {"type": "image_url", "image_url": {"url": data_uri}},
        ])
    ])
    raw: str = response.content if isinstance(response.content, str) else ""
    is_approved = "APPROVED" in raw

    log.debug("[%s] REVIEW: %s", artifact.input.object_name, raw)

    comment = raw if is_approved else (
        f"{error_prefix}\n\n---\n\n{raw}" if error_prefix else raw
    )
    return artifact.copy_with(review=Review(approved=is_approved, comment=comment))


# ---------------------------------------------------------------------------
# Graph nodes
# ---------------------------------------------------------------------------


async def craft_node(state: Craft3DState) -> dict:
    version = str(len(state["artifact_history"]) + 1)
    artifact = await _create_artifact(version=version, input=state["input"])
    return {"artifact_history": artifact, "current_version": version}


async def render_node(state: Craft3DState) -> dict:
    current = get_current_artifact(state)
    if current is None:
        return {}
    rendered = await _render_artifact(current)
    return {"artifact_history": replace_artifact_in_history(state["artifact_history"], rendered)}


async def review_node(state: Craft3DState) -> dict:
    current = get_current_artifact(state)
    if current is None:
        return {}
    reviewed = await _review_artifact(current)
    asyncio.ensure_future(_debug_save_artifact(reviewed))
    return {"artifact_history": replace_artifact_in_history(state["artifact_history"], reviewed)}


async def revise_node(state: Craft3DState) -> dict:
    current = get_current_artifact(state)
    if current is None:
        raise ValueError("No current artifact found for revision")

    version = str(len(state["artifact_history"]) + 1)
    artifact = await _create_artifact(
        version=version,
        input=state["input"],
        fallback_code=current.code,
        additional_content=[{
            "type": "text",
            "text": _render_revise_prompt({
                "code": current.code or "",
                "comment": current.review.comment if current.review else "None",
            }),
        }],
    )
    return {
        "artifact_history": artifact,
        "current_version": version,
        "revise_count": 1,  # reducer: current + 1
    }
