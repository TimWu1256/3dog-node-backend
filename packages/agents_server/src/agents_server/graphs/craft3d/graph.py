"""
craft3d graph – assembly, compilation, and public invoke function.
"""

from __future__ import annotations

import logging
from typing import cast

from langgraph.graph import END, START, StateGraph

from agents_server.common.schemas import ObjectProps
from agents_server.graphs.craft3d.edges import review_router
from agents_server.graphs.craft3d.nodes import (
    craft_node,
    render_node,
    review_node,
    revise_node,
)
from agents_server.graphs.craft3d.state import Craft3DState, get_current_artifact

log = logging.getLogger("graphs.craft3d")

# ---------------------------------------------------------------------------
# Graph definition
# ---------------------------------------------------------------------------

craft3d_agent = (
    StateGraph(Craft3DState)
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

# ---------------------------------------------------------------------------
# Public entrypoint
# ---------------------------------------------------------------------------


async def invoke_craft3d_agent(input: ObjectProps) -> dict:
    """
    Run the craft3d agent to completion and return the final state
    plus a convenience  `current_artifact`  key.
    """
    initial: Craft3DState = {
        "input": input,
        "artifact_history": [],
        "current_version": None,
        "revise_count": 0,
    }

    final: Craft3DState = initial

    async for _event in craft3d_agent.astream(
        initial, stream_mode=["updates", "values"]
    ):
        event = cast(tuple[str, dict], _event)
        mode = event[0]
        chunk = event[1]

        if mode == "updates":
            for node_name, value in chunk.items():
                if value:
                    log.debug(
                        "node %r updated: %s",
                        node_name,
                        ", ".join(repr(k) for k in value),
                    )
        elif mode == "values":
            final = chunk  # type: ignore[assignment]

    return {**final, "current_artifact": get_current_artifact(final)}