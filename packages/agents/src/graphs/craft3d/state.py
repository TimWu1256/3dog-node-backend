"""
State definition and core data models for the craft3d graph.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Annotated, Optional

from typing_extensions import TypedDict

from agents.src.common.schemas import ObjectProps


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class Review:
    approved: bool
    comment: str


@dataclass
class Artifact:
    version: str
    input: ObjectProps
    code: Optional[str] = None
    glb: Optional[bytes] = None
    snapshot: Optional[bytes] = None
    errors: list[str] = field(default_factory=list)
    review: Optional[Review] = None

    def copy_with(self, **kwargs) -> "Artifact":
        """Return a shallow copy with overridden fields."""
        current = {
            "version": self.version,
            "input": self.input,
            "code": self.code,
            "glb": self.glb,
            "snapshot": self.snapshot,
            "errors": self.errors,
            "review": self.review,
        }
        current.update(kwargs)
        return Artifact(**current)


# ---------------------------------------------------------------------------
# Reducers
# ---------------------------------------------------------------------------


def _artifact_history_reducer(
    current: list[Artifact],
    update: Artifact | list[Artifact],
) -> list[Artifact]:
    """Append a single Artifact, or replace the whole list when given a list."""
    if isinstance(update, list):
        return update
    return [*current, update]


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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def get_current_artifact(state: Craft3DState) -> Optional[Artifact]:
    version = state["current_version"]
    if version is None:
        return None
    for a in reversed(state["artifact_history"]):
        if a.version == version:
            return a
    return None


def replace_artifact_in_history(
    history: list[Artifact], updated: Artifact
) -> list[Artifact]:
    """Return a new list with the matching version replaced by `updated`."""
    return [updated if a.version == updated.version else a for a in history]
