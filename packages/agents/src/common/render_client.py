"""
HTTP client for the Node.js /render-glb service.

Request  (CBOR):  { code: str, timeoutMs: int }
Response (CBOR):  { success: True,  glb: bytes, snapshot: bytes }
               |  { success: False, error: str }
"""

import os
from dataclasses import dataclass

import cbor2
import httpx

_DEFAULT_RENDER_GLB_URL = os.environ.get(
    "RENDER_GLB_URL", "http://localhost:3609/render-glb"
)


@dataclass
class RenderGlbResult:
    glb: bytes
    snapshot: bytes


class RenderGlbError(RuntimeError):
    pass


async def render_glb(
    code: str,
    *,
    timeout_ms: int = 10_000,
    url: str = _DEFAULT_RENDER_GLB_URL,
) -> RenderGlbResult:
    payload = cbor2.dumps({"code": code, "timeoutMs": timeout_ms})

    async with httpx.AsyncClient() as client:
        response = await client.post(
            url,
            content=payload,
            headers={"Content-Type": "application/cbor"},
            timeout=timeout_ms / 1000 + 5,  # HTTP timeout slightly above job timeout
        )
        response.raise_for_status()

    result: dict = cbor2.loads(response.content)

    if not result.get("success"):
        raise RenderGlbError(result.get("error", "Unknown render error"))

    return RenderGlbResult(
        glb=bytes(result["glb"]),
        snapshot=bytes(result["snapshot"]),
    )
