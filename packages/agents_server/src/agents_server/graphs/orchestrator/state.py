"""
State definition and data models for the orchestrator graph.

The orchestrator maintains a persistent event log across all runs on a thread,
accumulating Realtime API events (tool calls, tool results, transcripts) for
context management. Each run processes one incoming event.
"""

from __future__ import annotations

import operator
from enum import Enum
from typing import Annotated, Optional

from pydantic import BaseModel
from typing_extensions import TypedDict


# ---------------------------------------------------------------------------
# Event types — mirrors the Realtime API event categories we care about.
# Delta events (audio, transcript chunk) are excluded.
# ---------------------------------------------------------------------------


class EventType(str, Enum):
    TOOL_CALL = "tool_call"          # AI issued a function call
    TOOL_RESULT = "tool_result"      # Sub-agent completed; result recorded
    TRANSCRIPT = "transcript"        # User speech transcription completed
    TRANSCRIPT_DONE = "transcript_done"  # AI response transcript completed


# ---------------------------------------------------------------------------
# Pydantic models for type-safe event construction
# ---------------------------------------------------------------------------


class RealtimeEvent(BaseModel):
    """A single Realtime API event recorded in the orchestrator log."""

    type: EventType
    timestamp: str  # ISO 8601
    data: dict      # type-specific payload


class SubagentResult(BaseModel):
    """Output returned by a sub-agent invocation (e.g. craft3d)."""

    job_id: str = ""
    glb_url: str = ""
    csharp_url: str = ""
    failure_reason: Optional[str] = None

    @property
    def is_success(self) -> bool:
        return bool(self.glb_url)


class AnimationAgentResult(BaseModel):
    """Output returned by the Animation Agent after Craft3D succeeds."""

    job_id: str = ""
    csharp_ready: bool = False
    csharp_url: str = ""
    planner_class_name: str = ""
    failure_reason: Optional[str] = None

    @property
    def is_success(self) -> bool:
        return self.csharp_ready and not self.failure_reason


# ---------------------------------------------------------------------------
# State reducer
# ---------------------------------------------------------------------------


def _events_reducer(
    current: list[dict],
    update: dict | list[dict],
) -> list[dict]:
    """Append a single event dict, or extend with a list of event dicts."""
    if isinstance(update, list):
        return current + update
    return current + [update]


# ---------------------------------------------------------------------------
# Graph state
# ---------------------------------------------------------------------------


class OrchestratorState(TypedDict):
    # Accumulated event log — append-only across all runs on this thread.
    events: Annotated[list[dict], _events_reducer]

    # Per-run input: the Realtime API event to process in this run.
    # LangGraph merges run input into state, so this is overwritten each run.
    current_event: Optional[dict]

    # Per-run output: populated only when a tool_call triggers a sub-agent.
    # Unity reads this from /threads/{id}/state after a tool_call run.
    subagent_result: Optional[dict]

    # Optional debug/audit result from the Animation Agent. Unity can keep using
    # subagent_result.csharp_url for the runtime handoff.
    animation_result: Optional[dict]


# ---------------------------------------------------------------------------
# Output schema — keys returned by /runs/wait for tool_call runs.
# ---------------------------------------------------------------------------


class OrchestratorOutput(TypedDict):
    subagent_result: Optional[dict]
    animation_result: Optional[dict]
