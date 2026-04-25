"""animation_agent graph – assembly."""

from __future__ import annotations

from langgraph.graph import END, START, StateGraph

from agents_server.graphs.animation_agent.nodes import generate, save
from agents_server.graphs.animation_agent.state import AnimationAgentState

animation_agent = (
    StateGraph(AnimationAgentState)
    .add_node("generate", generate)
    .add_node("save", save)
    .add_edge(START, "generate")
    .add_edge("generate", "save")
    .add_edge("save", END)
    .compile()
)
