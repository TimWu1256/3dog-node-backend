"""
Orchestrator graph — assembly and compilation.

The orchestrator is the context manager for a Unity Realtime API session.
Each run processes one incoming event:

  START
    ↓
  record_event  ─── (tool_call for known tool) ──► invoke_craft3d ──► END
                └── (all other events) ───────────────────────────────► END

State persists across all runs on a thread (one thread = one session), so
the `events` list accumulates the full Realtime API history for the session.
"""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from agents_server.graphs.orchestrator.edges import TOOL_DISPATCH, event_router
from agents_server.graphs.orchestrator.nodes import invoke_craft3d_node, record_event_node
from agents_server.graphs.orchestrator.state import OrchestratorOutput, OrchestratorState

# ---------------------------------------------------------------------------
# Graph definition
# ---------------------------------------------------------------------------

_builder = StateGraph(OrchestratorState, output=OrchestratorOutput)

_builder.add_node("record_event", record_event_node)

# Register one sub-agent node per tool in the dispatch table.
_builder.add_node("invoke_craft3d", invoke_craft3d_node)

_builder.add_edge(START, "record_event")

_builder.add_conditional_edges(
    "record_event",
    event_router,
    # All values that event_router can return must be listed here.
    [*TOOL_DISPATCH.values(), END],
)

# Each sub-agent node terminates after completion.
for _node in TOOL_DISPATCH.values():
    _builder.add_edge(_node, END)

orchestrator_agent = _builder.compile()
