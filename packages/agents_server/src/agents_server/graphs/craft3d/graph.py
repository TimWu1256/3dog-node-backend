"""
craft3d graph – assembly and compilation.
"""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from agents_server.graphs.craft3d.edges import review_router
from agents_server.graphs.craft3d.nodes import (
    craft,
    render,
    review,
    revise,
)
from agents_server.graphs.craft3d.state import Craft3DOutput, Craft3DState

# ---------------------------------------------------------------------------
# Graph definition
# ---------------------------------------------------------------------------

craft3d_agent = (
    StateGraph(Craft3DState, output=Craft3DOutput)
    .add_node("craft", craft)
    .add_node("render", render)
    .add_node("review", review)
    .add_node("revise", revise)
    .add_edge(START, "craft")
    .add_edge("craft", "render")
    .add_edge("render", "review")
    .add_edge("revise", "render")
    .add_conditional_edges("review", review_router, ["revise", END])
    .compile()
)
