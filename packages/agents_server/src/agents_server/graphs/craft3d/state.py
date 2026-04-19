"""
State definition and core data models for the craft3d graph.

Both Review and Artifact are Pydantic BaseModels so that LangGraph's checkpoint
serialiser and FastAPI's jsonable_encoder can fully round-trip them through JSON.

bytes fields (snapshot) are serialised as base64 strings and deserialised
back to bytes automatically via field_serializer / field_validator.
"""

from __future__ import annotations

import base64
from typing import Annotated, Optional

from pydantic import BaseModel, Field, field_serializer, field_validator
from typing_extensions import TypedDict

from agents_server.common.schemas import ObjectProps


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


class Review(BaseModel):
    approved: bool
    comment: str


class Artifact(BaseModel):
    version: str
    input: ObjectProps
    code: Optional[str] = None
    snapshot: Optional[bytes] = None
    errors: list[str] = Field(default_factory=list)
    review: Optional[Review] = None
    job_id: str = ""

    # ------------------------------------------------------------------
    # bytes ↔ base64 so the model round-trips cleanly through JSON
    # (LangGraph checkpoints, HTTP state API, etc.)
    # ------------------------------------------------------------------

    @field_validator("snapshot", mode="before")
    @classmethod
    def _decode_bytes(cls, v: Optional[bytes | str]) -> Optional[bytes]:
        if v is None:
            return None
        if isinstance(v, str):
            return base64.b64decode(v)
        return v

    @field_serializer("snapshot")
    def _encode_bytes(self, v: Optional[bytes]) -> Optional[str]:
        if v is None:
            return None
        return base64.b64encode(v).decode("ascii")

    def copy_with(self, **kwargs) -> "Artifact":
        """Return a copy with overridden fields (Pydantic v2)."""
        return self.model_copy(update=kwargs)

    model_config = {"arbitrary_types_allowed": True}


# ---------------------------------------------------------------------------
# Coercion helpers (LangGraph checkpointing deserialises Pydantic models as
# plain dicts; these helpers restore the original types on the way out)
# ---------------------------------------------------------------------------


def _coerce_artifact(val: "Artifact | dict") -> "Artifact":
    if isinstance(val, dict):
        return Artifact.model_validate(val)
    return val


# ---------------------------------------------------------------------------
# Reducers
# ---------------------------------------------------------------------------


def _artifact_history_reducer(
    current: list[Artifact],
    update: "Artifact | dict | list[Artifact | dict]",
) -> list[Artifact]:
    """Append a single Artifact, or replace the whole list when given a list."""
    coerced_current = [_coerce_artifact(a) for a in current]
    if isinstance(update, list):
        return [_coerce_artifact(a) for a in update]
    return [*coerced_current, _coerce_artifact(update)]


def _revise_count_reducer(current: int, delta: int) -> int:
    return current + delta


# ---------------------------------------------------------------------------
# Graph state
# ---------------------------------------------------------------------------


class Craft3DState(TypedDict):
    input: ObjectProps
    artifact_history: Annotated[list[Artifact], _artifact_history_reducer]
    current_version: Optional[str]
    revise_count: Annotated[int, _revise_count_reducer]
    # Top-level fields set by render_node / review_node for fast access
    # without parsing artifact_history.
    job_id: str
    glb_url: str              # download URL; empty if no render has succeeded yet
    csharp_url: str           # C# animation script URL; empty until csharp agent is developed
    failure_reason: Optional[str]  # set by review_node when not approved; None on success


# ---------------------------------------------------------------------------
# Output schema — what /runs/wait and stream endpoints return to clients.
# Does NOT affect the full state stored in checkpoints.
# ---------------------------------------------------------------------------


class Craft3DOutput(TypedDict):
    job_id: str              # empty string if all renders failed
    glb_url: str             # GLB download URL; empty string if all renders failed
    csharp_url: str          # C# animation script URL; empty until csharp agent is developed
    failure_reason: Optional[str]  # None on success; review comment on failure


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def get_current_artifact(state: Craft3DState) -> Optional[Artifact]:
    version = state.get("current_version")
    if version is None:
        return None
    for a in reversed(state["artifact_history"]):
        artifact = _coerce_artifact(a)
        if artifact.version == version:
            return artifact
    return None


def replace_artifact_in_history(
    history: list[Artifact], updated: Artifact
) -> list[Artifact]:
    """Return a new list with the matching version replaced by `updated`."""
    return [
        updated if _coerce_artifact(a).version == updated.version else _coerce_artifact(a)
        for a in history
    ]
