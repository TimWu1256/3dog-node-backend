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
    bundle: Any              # ToolServerAnimationBundle
    # intermediate (frozen dataclasses; not checkpointed)
    planner: Optional[Any]   # PlannerSource
    # outputs
    csharp_url: str
    planner_class_name: str
    failure_reason: Optional[str]
    # optional model overrides (omit to use server defaults)
    model: Optional[str]     # e.g. "openai/gpt-5.4" or "google/gemini-3-flash-preview"
    reasoning: Optional[str] # e.g. "low", "medium", "high"
