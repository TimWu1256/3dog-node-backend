"""
HTTP client for the craft3d POST /render endpoint.

Request  (JSON):  { code: str, timeoutSec: int }
Response (JSON):  { success: True,  job_id: str, glb: str (base64), snapshot: str (base64) }
               |  { success: False, error: str }
"""

import base64
import os
from dataclasses import dataclass

import httpx

# Base URL of the craft3d service (used to construct download URLs).
_RENDER_SERVICE_URL = os.environ.get("RENDER_SERVICE_URL", "http://localhost:3601")

_DEFAULT_RENDER_URL = os.environ.get(
    "RENDER_GLB_URL", f"{_RENDER_SERVICE_URL}/render"
)


def get_glb_url(job_id: str) -> str:
    """Return the download URL for a rendered GLB given its job_id."""
    return f"{_RENDER_SERVICE_URL}/jobs/{job_id}/glb"


@dataclass
class RenderGlbResult:
    glb: bytes
    snapshot: bytes
    job_id: str = ""


class RenderGlbError(RuntimeError):
    pass


async def render_glb(
    code: str,
    *,
    timeout_ms: int = 60_000,
    url: str = _DEFAULT_RENDER_URL,
) -> RenderGlbResult:
    timeout_sec = max(1, min(120, timeout_ms // 1000))
    payload = {"code": code, "timeoutSec": timeout_sec}

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                url,
                json=payload,
                timeout=timeout_sec + 10,  # HTTP timeout slightly above job timeout
            )
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise RenderGlbError(str(exc)) from exc

    result: dict = response.json()

    if not result.get("success"):
        raise RenderGlbError(result.get("error", "Unknown render error"))

    return RenderGlbResult(
        glb=base64.b64decode(result["glb"]),
        snapshot=base64.b64decode(result["snapshot"]),
        job_id=result.get("job_id", ""),
    )
