"""
Conditional edge routers for the craft3d graph.
"""

from langgraph.graph import END

from agents_server.graphs.craft3d.state import Craft3DState, get_current_artifact

MAX_REVIEWS = 1


def review_router(state: Craft3DState) -> str:
    artifact = get_current_artifact(state)

    if artifact is None:
        raise ValueError("No artifact was activated.")
    if artifact.review is None:
        raise ValueError("No review was done.")

    if artifact.review.approved or state["review_count"] >= MAX_REVIEWS:
        return END

    return "revise"
