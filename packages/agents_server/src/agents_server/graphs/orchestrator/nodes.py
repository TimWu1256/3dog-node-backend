"""
Node functions for the orchestrator graph.

Each node is a plain async function: (state) -> partial state update dict.

Nodes:
  record_event    — appends current_event to the persistent event log.
  invoke_craft3d  — invokes the craft3d graph as a sub-agent and records
                    the tool_result event.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from agents_server.common.schemas import ObjectProps
from agents_server.common.tool_server_client import fetch_animation_bundle
from agents_server.graphs.animation_agent import animation_agent
from agents_server.graphs.craft3d.graph import craft3d_agent
from agents_server.graphs.orchestrator.state import (
    AnimationAgentResult,
    EventType,
    OrchestratorState,
    RealtimeEvent,
    SubagentResult,
)

log = logging.getLogger("graphs.orchestrator")


# ---------------------------------------------------------------------------
# record_event
# ---------------------------------------------------------------------------


async def record_event_node(state: OrchestratorState) -> dict:
    """Append the current_event to the persistent event log.

    This runs for every incoming event regardless of type, providing a full
    audit trail for the session.
    """
    event = state.get("current_event")
    if not event:
        log.debug("record_event_node: no current_event, skipping")
        return {}

    event_type = event.get("type", "unknown")
    log.info("orchestrator: recording event type=%s", event_type)

    # Append to the accumulated log via the _events_reducer.
    return {"events": [event]}


# ---------------------------------------------------------------------------
# invoke_craft3d
# ---------------------------------------------------------------------------


async def invoke_craft3d_node(state: OrchestratorState) -> dict:
    """Invoke the craft3d sub-graph for a create_3d_object tool call.

    Extracts object_name / object_description from the tool call event,
    runs the craft3d graph as a sub-agent (blocking until completion), then
    records a tool_result event and returns the SubagentResult.
    """
    object_name, object_description, animation_enabled = _extract_object_request(state)

    log.info(
        "orchestrator: invoking craft3d sub-agent — name=%r description=%r animation_enabled=%r",
        object_name,
        object_description,
        animation_enabled,
    )

    try:
        # craft3d_agent is compiled without a checkpointer; ainvoke runs it
        # in-process and returns the Craft3DOutput keys.
        result_state = await craft3d_agent.ainvoke(
            {
                "input": ObjectProps(
                    object_name=object_name,
                    object_description=object_description,
                    animation_enabled=animation_enabled,
                )
            }
        )
        result = SubagentResult(
            job_id=result_state.get("job_id", ""),
            glb_url=result_state.get("glb_url", ""),
            csharp_url=result_state.get("csharp_url", ""),
            failure_reason=result_state.get("failure_reason"),
        )
        log.info(
            "orchestrator: craft3d finished — success=%s job_id=%s",
            result.is_success,
            result.job_id,
        )
    except Exception as exc:
        log.exception("orchestrator: craft3d sub-agent raised an exception")
        result = SubagentResult(failure_reason=f"{type(exc).__name__}: {exc}")

    # Record a tool_result event so the session log stays complete.
    tool_result_event = RealtimeEvent(
        type=EventType.TOOL_RESULT,
        timestamp=datetime.now(timezone.utc).isoformat(),
        data={
            "source": "create_3d_object",
            **result.model_dump(),
        },
    )

    return {
        "subagent_result": result.model_dump(),
        # _events_reducer appends this to the existing list.
        "events": [tool_result_event.model_dump()],
    }


# ---------------------------------------------------------------------------
# invoke_animation_agent
# ---------------------------------------------------------------------------


async def invoke_animation_agent_node(state: OrchestratorState) -> dict:
    """Generate and upload a Unity C# planner after Craft3D succeeds."""

    subagent_result = dict(state.get("subagent_result") or {})
    job_id = subagent_result.get("job_id") or ""
    glb_url = subagent_result.get("glb_url") or ""
    object_name, object_description, animation_enabled = _extract_object_request(state)

    if not animation_enabled:
        result = AnimationAgentResult(
            job_id=job_id,
            failure_reason="animation_enabled is false; Animation Agent skipped.",
        )
    elif not job_id or not glb_url:
        result = AnimationAgentResult(
            job_id=job_id,
            failure_reason="Craft3D did not produce a successful job; Animation Agent skipped.",
        )
    else:
        log.info(
            "orchestrator: invoking animation agent job_id=%s name=%r",
            job_id,
            object_name,
        )
        try:
            bundle = await fetch_animation_bundle(
                job_id=job_id,
                object_name=object_name,
                object_description=object_description,
            )
            raw = await animation_agent.ainvoke({
                "job_id": job_id,
                "bundle": bundle,
                "planner": None,
                "csharp_url": "",
                "planner_class_name": "",
                "failure_reason": None,
            })
            result = AnimationAgentResult(
                job_id=job_id,
                csharp_ready=bool(raw.get("csharp_url")),
                csharp_url=raw.get("csharp_url", ""),
                planner_class_name=raw.get("planner_class_name", ""),
                failure_reason=raw.get("failure_reason"),
            )
        except Exception as exc:
            result = AnimationAgentResult(
                job_id=job_id,
                failure_reason=f"{type(exc).__name__}: {exc}",
            )

    if result.csharp_url:
        subagent_result["csharp_url"] = result.csharp_url

    log.info(
        "orchestrator: animation agent finished success=%s job_id=%s class=%s",
        result.is_success,
        result.job_id,
        result.planner_class_name,
    )

    tool_result_event = RealtimeEvent(
        type=EventType.TOOL_RESULT,
        timestamp=datetime.now(timezone.utc).isoformat(),
        data={
            "source": "animation_agent",
            **result.model_dump(),
        },
    )

    return {
        "subagent_result": subagent_result,
        "animation_result": result.model_dump(),
        "events": [tool_result_event.model_dump()],
    }


def _extract_object_request(state: OrchestratorState) -> tuple[str, str, bool]:
    event = state.get("current_event") or {}
    data = event.get("data") or {}
    arguments = data.get("arguments") or {}

    object_name: str = arguments.get("object_name") or arguments.get("name") or ""
    object_description: str = (
        arguments.get("object_description") or arguments.get("description") or ""
    )
    animation_enabled: bool = bool(arguments.get("animation_enabled", False))
    return object_name, object_description, animation_enabled
