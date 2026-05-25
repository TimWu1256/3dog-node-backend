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
    """Generate a 3D object via the craft3d pipeline.

    Args:
        object_name: Unique identifier/name for the object (no spaces, e.g. "convex_lens").
        object_description: Natural language description of the object's shape and material.

    Returns:
        JSON string with job_id, glb_url (download link), csharp_url, and failure_reason if any.
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
        return json.dumps(run_resp.json(), ensure_ascii=False)


@mcp.tool()
async def generate_3d_object_with_animation(object_name: str, object_description: str) -> str:
    """Generate a 3D object with animation via the full orchestrator pipeline.

    Args:
        object_name: Unique identifier/name for the object (no spaces, e.g. "convex_lens").
        object_description: Natural language description of the object's shape and material.

    Returns:
        JSON string with job_id, glb_url, csharp_url (animation C# script), and failure_reason if any.
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
                    "input": {
                        "object_name": object_name,
                        "object_description": object_description,
                    }
                },
            },
            timeout=_HTTP_TIMEOUT,
        )
        run_resp.raise_for_status()
        return json.dumps(run_resp.json(), ensure_ascii=False)


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=3602)
