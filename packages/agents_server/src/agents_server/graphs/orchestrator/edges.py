"""
Conditional edge routers for the orchestrator graph.

TOOL_DISPATCH maps tool name → node name. Add entries here as new tools are
registered in the Realtime session. The router checks current_event.type and
current_event.data.name to decide where to route after record_event.
"""

from __future__ import annotations

from langgraph.graph import END

from agents_server.graphs.orchestrator.state import EventType, OrchestratorState

# ---------------------------------------------------------------------------
# Tool dispatch table
# Extend this dict to add routing for new tools without changing the router.
# ---------------------------------------------------------------------------

TOOL_DISPATCH: dict[str, str] = {
    "create_3d_object": "invoke_craft3d",
}


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def event_router(state: OrchestratorState) -> str:
    """Route to a sub-agent node for tool_call events; END otherwise.

    Returns a node name from TOOL_DISPATCH when current_event is a tool_call
    for a known tool, or END for all other event types (transcript, etc.).
    """
    event = state.get("current_event") or {}
    event_type = event.get("type")

    if event_type == EventType.TOOL_CALL:
        tool_name: str = (event.get("data") or {}).get("name", "")
        target = TOOL_DISPATCH.get(tool_name)
        if target:
            return target

    return END
