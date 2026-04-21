"""animation_agent graph – assembly and public entry point."""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from agents_server.graphs.animation_agent.edges import after_fetch_router, after_generate_router
from agents_server.graphs.animation_agent.nodes import (
    fetch_bundle_node,
    generate_planner_node,
    upload_planner_node,
)
from agents_server.graphs.animation_agent.state import AnimationAgentState, AnimationPlannerResult

# ---------------------------------------------------------------------------
# Graph definition
# ---------------------------------------------------------------------------

_animation_agent = (
    StateGraph(AnimationAgentState)
    .add_node("fetch_bundle_node", fetch_bundle_node)
    .add_node("generate_planner_node", generate_planner_node)
    .add_node("upload_planner_node", upload_planner_node)
    .add_edge(START, "fetch_bundle_node")
    .add_conditional_edges(
        "fetch_bundle_node",
        after_fetch_router,
        ["generate_planner_node", END],
    )
    .add_conditional_edges(
        "generate_planner_node",
        after_generate_router,
        ["upload_planner_node", END],
    )
    .add_edge("upload_planner_node", END)
    .compile()
)


# ---------------------------------------------------------------------------
# Public entry point — signature identical to the original flat module
# ---------------------------------------------------------------------------


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
        result = await _animation_agent.ainvoke(
            {
                "job_id": job_id,
                "object_name": object_name,
                "object_description": object_description,
                "user_prompt": user_prompt,
                "bundle": None,
                "planner": None,
                "csharp_url": "",
                "planner_class_name": "",
                "failure_reason": None,
            }
        )

        if result.get("failure_reason"):
            return AnimationPlannerResult(
                job_id=job_id,
                failure_reason=result["failure_reason"],
            )

        return AnimationPlannerResult(
            job_id=job_id,
            csharp_ready=True,
            csharp_url=result.get("csharp_url", ""),
            planner_class_name=result.get("planner_class_name", ""),
        )
    except Exception as exc:
        return AnimationPlannerResult(
            job_id=job_id,
            failure_reason=f"{type(exc).__name__}: {exc}",
        )
