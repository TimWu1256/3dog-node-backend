"""
Conditional edge routers for the craft3d graph.
"""

from langgraph.graph import END

from agents_server.graphs.craft3d.state import Craft3DState, get_current_artifact

MAX_REVIEWS = 1


def review_router(state: Craft3DState) -> str:
    if state.get("skip_review"):
        return END

    artifact = get_current_artifact(state)

    if artifact is None:
        raise ValueError("No artifact was activated.")
    if artifact.review is None:
        raise ValueError("No review was done.")

    effective_max = state.get("max_reviews") or MAX_REVIEWS
    if artifact.review.approved or state["review_count"] >= effective_max:
        return END

    return "revise"
