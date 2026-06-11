"""Tool-server helpers used by the backend Animation Agent."""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from typing import Any

import os

import httpx


TOOL_SERVER_BASE_URL = os.getenv("TOOL_SERVER_URL", "http://localhost:3601")
# Client-accessible URL (e.g. Unity on Windows host); defaults to internal URL if not set.
TOOL_SERVER_PUBLIC_URL = os.getenv("TOOL_SERVER_PUBLIC_URL", TOOL_SERVER_BASE_URL)

_JOB_PATH_TEMPLATE = "/jobs/{id}"
_CODE_PATH_TEMPLATE = "/jobs/{id}/code"
_SNAPSHOT_PATH_TEMPLATE = "/jobs/{id}/snapshot"
_CSHARP_PATH_TEMPLATE = "/jobs/{id}/csharp"

_FETCH_ATTEMPTS = 3
_FETCH_INTERVAL_SEC = 1.5


class ToolServerArtifactError(RuntimeError):
    """Raised when required tool-server artifacts are unavailable."""


@dataclass(frozen=True)
class ToolServerAnimationBundle:
    job_id: str
    object_name: str
    object_description: str
    job_metadata: dict[str, Any]
    code: str
    snapshot_base64: str
    snapshot_mime_type: str = "image/png"


@dataclass(frozen=True)
class UploadedPlanner:
    csharp_url: str
    response_json: dict[str, Any] | None = None


def build_tool_server_url(path_template: str, job_id: str) -> str:
    path = path_template.format(id=job_id, job_id=job_id)
    if not path.startswith("/"):
        path = "/" + path
    return f"{TOOL_SERVER_BASE_URL}{path}"


def _build_public_url(path_template: str, job_id: str) -> str:
    """Build a client-accessible URL using TOOL_SERVER_PUBLIC_URL."""
    path = path_template.format(id=job_id, job_id=job_id)
    if not path.startswith("/"):
        path = "/" + path
    return f"{TOOL_SERVER_PUBLIC_URL}{path}"


async def fetch_animation_bundle(
    *,
    job_id: str,
    object_name: str,
    object_description: str,
) -> ToolServerAnimationBundle:
    """Fetch metadata, generated Three.js code, and snapshot for animation planning."""

    async with httpx.AsyncClient(timeout=30) as client:
        job_metadata = await _get_json_with_retry(
            client,
            build_tool_server_url(_JOB_PATH_TEMPLATE, job_id),
            "job metadata",
        )
        code = await _get_text_with_retry(
            client,
            build_tool_server_url(_CODE_PATH_TEMPLATE, job_id),
            "generated code",
        )
        snapshot_bytes = await _get_bytes_with_retry(
            client,
            build_tool_server_url(_SNAPSHOT_PATH_TEMPLATE, job_id),
            "snapshot",
        )

    return ToolServerAnimationBundle(
        job_id=job_id,
        object_name=object_name,
        object_description=object_description,
        job_metadata=job_metadata,
        code=code,
        snapshot_base64=base64.b64encode(snapshot_bytes).decode("ascii"),
    )


async def upload_csharp_planner(*, job_id: str, csharp: str) -> UploadedPlanner:
    """Upload generated planner source to the tool-server C# endpoint."""

    url = build_tool_server_url(_CSHARP_PATH_TEMPLATE, job_id)
    public_url = _build_public_url(_CSHARP_PATH_TEMPLATE, job_id)

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            url,
            content=csharp.encode("utf-8"),
            headers={"Content-Type": "text/plain; charset=utf-8"},
        )
        if response.status_code >= 400:
            raise ToolServerArtifactError(
                f"POST {url} failed with HTTP {response.status_code}: {response.text[:400]}"
            )

    return UploadedPlanner(csharp_url=public_url)


async def _get_json_with_retry(
    client: httpx.AsyncClient,
    url: str,
    label: str,
) -> dict[str, Any]:
    last_error = ""

    for _ in range(max(1, _FETCH_ATTEMPTS)):
        try:
            response = await client.get(url)
            if response.status_code == 200:
                return response.json()
            last_error = f"HTTP {response.status_code}: {response.text[:300]}"
        except (httpx.HTTPError, ValueError) as exc:
            last_error = str(exc)

        await _sleep_between_attempts()

    raise ToolServerArtifactError(f"Could not fetch {label} from {url}: {last_error}")


async def _get_text_with_retry(
    client: httpx.AsyncClient,
    url: str,
    label: str,
) -> str:
    last_error = ""

    for _ in range(max(1, _FETCH_ATTEMPTS)):
        try:
            response = await client.get(url)
            if response.status_code == 200 and response.text.strip():
                return response.text
            last_error = f"HTTP {response.status_code}: {response.text[:300]}"
        except httpx.HTTPError as exc:
            last_error = str(exc)

        await _sleep_between_attempts()

    raise ToolServerArtifactError(f"Could not fetch {label} from {url}: {last_error}")


async def _get_bytes_with_retry(
    client: httpx.AsyncClient,
    url: str,
    label: str,
) -> bytes:
    last_error = ""

    for _ in range(max(1, _FETCH_ATTEMPTS)):
        try:
            response = await client.get(url)
            if response.status_code == 200 and response.content:
                return response.content
            last_error = f"HTTP {response.status_code}: {response.text[:300]}"
        except httpx.HTTPError as exc:
            last_error = str(exc)

        await _sleep_between_attempts()

    raise ToolServerArtifactError(f"Could not fetch {label} from {url}: {last_error}")


async def _sleep_between_attempts() -> None:
    await asyncio.sleep(max(0.1, _FETCH_INTERVAL_SEC))
