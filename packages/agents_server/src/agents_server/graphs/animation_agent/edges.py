"""Conditional edge routers for the animation_agent graph."""

from __future__ import annotations

from langgraph.graph import END

from agents_server.graphs.animation_agent.state import AnimationAgentState


def after_fetch_router(state: AnimationAgentState) -> str:
    return END if state.get("failure_reason") else "generate_planner_node"


def after_generate_router(state: AnimationAgentState) -> str:
    return END if state.get("failure_reason") else "upload_planner_node"
