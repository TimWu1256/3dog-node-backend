from __future__ import annotations

import json
import os

import httpx
from fastmcp import FastMCP

mcp = FastMCP("3dog-agent")

# Inside Docker network: http://langgraph-agents:8000; on host: http://127.0.0.1:3600
LANGGRAPH_URL = os.getenv("LANGGRAPH_URL", "http://127.0.0.1:3600")
_HTTP_TIMEOUT = 300.0


@mcp.tool()
async def generate_3d_object(object_name: str, object_description: str) -> str:
    """Generate a static 3D object (no animation) via the craft3d pipeline.

    Use this when the user requests a 3D model WITHOUT animation effects.

    Args:
        object_name: Name for the object (e.g. "hanging lantern", "ancient shrine gate").
        object_description: Natural language description of the object's shape and material.

    Returns:
        JSON string with object_name, job_id, glb_url (download link), and failure_reason if any.
        Note: csharp_url is NOT included (no animation).
    """
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
        thread_resp = await client.post(f"{LANGGRAPH_URL}/threads", json={})
        thread_resp.raise_for_status()
        thread_id = thread_resp.json()["thread_id"]

        run_resp = await client.post(
            f"{LANGGRAPH_URL}/threads/{thread_id}/runs/wait",
            json={
                "assistant_id": "craft3d",
                "input": {
                    "input": {
                        "object_name": object_name,
                        "object_description": object_description,
                    }
                },
            },
            timeout=_HTTP_TIMEOUT,
        )
        run_resp.raise_for_status()
        result = run_resp.json()
        result["object_name"] = object_name
        return json.dumps(result, ensure_ascii=False)


@mcp.tool()
async def generate_3d_object_with_animation(object_name: str, object_description: str) -> str:
    """Generate a 3D object WITH animation (rotation, movement, effects) via the full orchestrator pipeline.

    Use this when the user requests animation, rotation, movement, or visual effects.
    Returns a Unity C# animation script in addition to the 3D model.

    Args:
        object_name: Name for the object (e.g. "rotating lantern", "spinning gear").
        object_description: Natural language description including desired animation or motion (e.g. "spinning globe").

    Returns:
        JSON string with object_name, job_id, glb_url (download link), csharp_url (Unity animation C# script), and failure_reason if any.
    """
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
        thread_resp = await client.post(f"{LANGGRAPH_URL}/threads", json={})
        thread_resp.raise_for_status()
        thread_id = thread_resp.json()["thread_id"]

        run_resp = await client.post(
            f"{LANGGRAPH_URL}/threads/{thread_id}/runs/wait",
            json={
                "assistant_id": "orchestrator",
                "input": {
                    "current_event": {
                        "type": "tool_call",
                        "data": {
                            "name": "create_3d_object",
                            "arguments": {
                                "object_name": object_name,
                                "object_description": object_description,
                                "with_animation": True,
                            },
                        },
                    }
                },
            },
            timeout=_HTTP_TIMEOUT,
        )
        run_resp.raise_for_status()
        full_result = run_resp.json()
        result = full_result.get("subagent_result") or {}
        result["object_name"] = object_name
        return json.dumps(result, ensure_ascii=False)


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=3602)
