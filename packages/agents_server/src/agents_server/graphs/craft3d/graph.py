"""
craft3d graph – assembly and compilation.
"""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from agents_server.graphs.craft3d.edges import review_router
from agents_server.graphs.craft3d.nodes import (
    craft_node,
    render_node,
    review_node,
    revise_node,
)
from agents_server.graphs.craft3d.state import Craft3DOutput, Craft3DState

# ---------------------------------------------------------------------------
# Graph definition
# ---------------------------------------------------------------------------

craft3d_agent = (
    StateGraph(Craft3DState, output=Craft3DOutput)
    .add_node("craft_node", craft_node)
    .add_node("render_node", render_node)
    .add_node("review_node", review_node)
    .add_node("revise_node", revise_node)
    .add_edge(START, "craft_node")
    .add_edge("craft_node", "render_node")
    .add_edge("render_node", "review_node")
    .add_edge("revise_node", "render_node")
    .add_conditional_edges("review_node", review_router, ["revise_node", END])
    .compile()
)
