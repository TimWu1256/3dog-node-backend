"""State definition and data models for the animation_agent graph."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from typing_extensions import TypedDict


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


class AnimationAgentState(TypedDict):
    # inputs
    job_id: str
    object_name: str
    object_description: str
    user_prompt: str
    # intermediate (frozen dataclasses; not checkpointed)
    bundle: Optional[Any]   # ToolServerAnimationBundle
    planner: Optional[Any]  # PlannerSource
    # outputs
    csharp_url: str
    planner_class_name: str
    failure_reason: Optional[str]
