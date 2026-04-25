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
from langchain_openai import ChatOpenAI

from agents_server.common.instructions import load_instructions_template
from agents_server.common.render_client import RenderGlbError, get_glb_url, render_glb
from agents_server.common.schemas import ObjectProps
from agents_server.common.utils import extract_code_from_markdown, stringify_error
from agents_server.graphs.craft3d.state import (
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

_render_generation_prompt = load_instructions_template("craft3d-generation-v3")
_render_review_prompt = load_instructions_template("craft3d-review")
_render_revise_prompt = load_instructions_template("craft3d-revise")

# ---------------------------------------------------------------------------
# LLM clients (lazy-initialized to defer API key validation until first use)
# ---------------------------------------------------------------------------

_craft_model: ChatOpenAI | None = None
_review_model: ChatOpenAI | None = None


def _get_craft_model() -> ChatOpenAI:
    global _craft_model
    if _craft_model is None:
        _craft_model = ChatGoogleGenerativeAI(
            model="gemini-3-flash-preview",
            thinking_level="low",
        )
    return _craft_model


def _get_review_model() -> ChatOpenAI:
    global _review_model
    if _review_model is None:
        _review_model = ChatOpenAI(
            model="gpt-5.4-mini",
            reasoning_effort="low",
        )
    return _review_model

# ---------------------------------------------------------------------------
# Debug persistence
# ---------------------------------------------------------------------------


async def _debug_save_artifact(artifact: Artifact) -> None:
    import asyncio
    from pathlib import Path

    name = f"{time.time_ns()}_{artifact.input.object_name}_{artifact.version}"
    base = Path("./out") / name

    def _write() -> None:
        base.mkdir(parents=True, exist_ok=True)
        meta = {"props": artifact.input.model_dump(), "errors": artifact.errors}
        (base / "meta.txt").write_text(json.dumps(meta))
        if artifact.code:
            (base / "code.txt").write_text(artifact.code)
        if artifact.snapshot:
            (base / "snapshot.png").write_bytes(artifact.snapshot)
        if artifact.review:
            (base / "review.txt").write_text(artifact.review.comment)

    await asyncio.to_thread(_write)


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
        raw_content = response.content
        if isinstance(raw_content, str):
            raw = raw_content
        elif isinstance(raw_content, list):
            # Thinking models return a list of blocks (e.g. thinking + text).
            # Concatenate all non-thinking text blocks.
            raw = "\n".join(
                item.get("text", "") if isinstance(item, dict) else str(item)
                for item in raw_content
                if not (isinstance(item, dict) and item.get("type") == "thinking")
            )
        else:
            raw = ""
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
        # GLB bytes are NOT stored in state — download via /jobs/{job_id}/glb.
        return artifact.copy_with(snapshot=result.snapshot, job_id=result.job_id)
    except RenderGlbError as exc:
        return artifact.copy_with(errors=[*artifact.errors, stringify_error(exc)])
    except Exception as exc:
        return artifact.copy_with(errors=[*artifact.errors, stringify_error(exc)])


async def _review_artifact(artifact: Artifact) -> Artifact:
    error_prefix = (
        "Found error{}:\n\n{}".format(
            "s" if len(artifact.errors) > 1 else "", "\n".join(artifact.errors)
        )
        if len(artifact.errors) > 0
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


async def craft(state: Craft3DState) -> dict:
    version = str(len(state["artifact_history"]) + 1)
    input_props = ObjectProps.model_validate(state["input"]) if isinstance(state["input"], dict) else state["input"]
    log.info("[%s] craft v%s — generating Three.js code", input_props.object_name, version)
    artifact = await _create_artifact(version=version, input=input_props)
    if artifact.errors:
        log.warning("[%s] craft v%s — errors: %s", input_props.object_name, version, artifact.errors)
    else:
        log.info("[%s] craft v%s — code generated (%d chars)", input_props.object_name, version, len(artifact.code or ""))
    return {"artifact_history": artifact, "current_version": version}


async def render(state: Craft3DState) -> dict:
    current = get_current_artifact(state)
    if current is None:
        return {}
    log.info("[%s] render v%s — rendering GLB", current.input.object_name, current.version)
    rendered = await _render_artifact(current)
    if rendered.errors and rendered.errors != current.errors:
        log.warning("[%s] render v%s — errors: %s", current.input.object_name, current.version, rendered.errors)
    elif rendered.job_id:
        log.info("[%s] render v%s — GLB ready, job_id=%s", current.input.object_name, current.version, rendered.job_id)
    update: dict = {"artifact_history": replace_artifact_in_history(state["artifact_history"], rendered)}
    if rendered.job_id:
        update["job_id"] = rendered.job_id
        update["glb_url"] = get_glb_url(rendered.job_id)
    return update


async def review(state: Craft3DState) -> dict:
    current = get_current_artifact(state)
    if current is None:
        return {}
    log.info("[%s] review v%s — reviewing snapshot", current.input.object_name, current.version)
    reviewed = await _review_artifact(current)
    asyncio.ensure_future(_debug_save_artifact(reviewed))
    if reviewed.review is not None:
        if reviewed.review.approved:
            log.info("[%s] review v%s — APPROVED", current.input.object_name, current.version)
        else:
            log.info("[%s] review v%s — REJECTED: %s", current.input.object_name, current.version, reviewed.review.comment[:120])
    update: dict = {"artifact_history": replace_artifact_in_history(state["artifact_history"], reviewed)}
    if reviewed.review is not None:
        # Allow output if render succeeded, even when review rejects it
        update["failure_reason"] = None if (reviewed.review.approved or reviewed.job_id) else reviewed.review.comment
    update["review_count"] = 1  # reducer: current + 1
    return update


async def revise(state: Craft3DState) -> dict:
    current = get_current_artifact(state)
    if current is None:
        raise ValueError("No current artifact found for revision")

    version = str(len(state["artifact_history"]) + 1)
    input_props = ObjectProps.model_validate(state["input"]) if isinstance(state["input"], dict) else state["input"]
    log.info("[%s] revise v%s — revising based on review feedback", input_props.object_name, version)
    artifact = await _create_artifact(
        version=version,
        input=input_props,
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
    }
