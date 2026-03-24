"""
Layer 1 – render_client integration tests.

Requires: render server running at RENDER_GLB_URL (default http://localhost:3601/render).
"""

from __future__ import annotations

import pytest

from agents_server.common.render_client import RenderGlbError, render_glb
from tests.integration.conftest import requires_render


@requires_render
class TestRenderClient:
    @pytest.mark.asyncio
    async def test_valid_code_returns_glb_and_snapshot(self, minimal_threejs_code):
        result = await render_glb(minimal_threejs_code, timeout_ms=15_000)

        assert isinstance(result.glb, bytes), "glb 應是 bytes"
        assert len(result.glb) > 0, "glb 不能是空的"
        assert isinstance(result.snapshot, bytes), "snapshot 應是 bytes"
        assert len(result.snapshot) > 0, "snapshot 不能是空的"

    @pytest.mark.asyncio
    async def test_valid_code_returns_job_id(self, minimal_threejs_code):
        result = await render_glb(minimal_threejs_code, timeout_ms=15_000)
        assert isinstance(result.job_id, str)
        assert result.job_id != "", "job_id 不應為空"

    @pytest.mark.asyncio
    async def test_snapshot_is_png(self, minimal_threejs_code):
        result = await render_glb(minimal_threejs_code, timeout_ms=15_000)
        # PNG magic bytes: \x89PNG
        assert result.snapshot[:4] == b"\x89PNG", "snapshot 應為 PNG 格式"

    @pytest.mark.asyncio
    async def test_glb_has_glb_magic_bytes(self, minimal_threejs_code):
        result = await render_glb(minimal_threejs_code, timeout_ms=15_000)
        # GLB magic: 0x46546C67 little-endian = b'glTF'
        assert result.glb[:4] == b"glTF", "glb 應為合法的 GLB/glTF 格式"

    @pytest.mark.asyncio
    async def test_invalid_code_raises_render_error(self):
        broken_code = "this is not valid JavaScript @@@###"
        with pytest.raises(RenderGlbError):
            await render_glb(broken_code, timeout_ms=10_000)
