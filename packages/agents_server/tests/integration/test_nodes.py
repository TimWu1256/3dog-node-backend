"""
Layer 2 – single-node integration tests.

Each test class targets one node and only mocks the *other* service,
so failures are isolated to a single dependency.

  TestCraftNodeLLM    – real Gemini,  mocked render server
  TestRenderNodeReal  – real render server, mocked Gemini
  TestReviewNodeLLM   – real Gemini,  mocked render server  (snapshot provided)
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from agents_server.common.render_client import RenderGlbResult
from agents_server.common.schemas import ObjectProps
from agents_server.graphs.craft3d.nodes import craft_node, render_node, review_node
from agents_server.graphs.craft3d.state import Artifact, Craft3DState, Review
from tests.integration.conftest import requires_llm, requires_render

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_INPUT = ObjectProps(
    object_name="Wooden Crate",
    object_description="A simple wooden crate with visible planks and metal corners.",
)


def _base_state(**overrides) -> Craft3DState:
    return {
        "input": _INPUT,
        "artifact_history": [],
        "current_version": None,
        "revise_count": 0,
        "job_id": "",
        **overrides,
    }


# ---------------------------------------------------------------------------
# craft_node  (real LLM)
# ---------------------------------------------------------------------------


@requires_llm
class TestCraftNodeLLM:
    @pytest.mark.asyncio
    async def test_generates_code(self):
        state = _base_state()
        result = await craft_node(state)

        assert result["current_version"] == "1"
        artifact: Artifact = result["artifact_history"]
        assert artifact.code, "LLM 應產生 Three.js 程式碼"
        assert len(artifact.code) > 50, "程式碼應該有實質內容"

    @pytest.mark.asyncio
    async def test_code_looks_like_threejs(self):
        state = _base_state()
        result = await craft_node(state)

        code: str = result["artifact_history"].code or ""
        threejs_keywords = {"THREE", "scene", "geometry", "material", "mesh"}
        found = {kw for kw in threejs_keywords if kw in code}
        assert found, f"程式碼應包含 Three.js 關鍵字，實際找到: {found}"

    @pytest.mark.asyncio
    async def test_version_increments(self):
        existing = Artifact(version="1", input=_INPUT, code="// v1")
        state = _base_state(
            artifact_history=[existing],
            current_version="1",
        )
        result = await craft_node(state)
        assert result["current_version"] == "2"


# ---------------------------------------------------------------------------
# render_node  (real render server)
# ---------------------------------------------------------------------------


@requires_render
class TestRenderNodeReal:
    def _state_with_code(self, code: str) -> Craft3DState:
        artifact = Artifact(version="1", input=_INPUT, code=code)
        return _base_state(
            artifact_history=[artifact],
            current_version="1",
        )

    @pytest.mark.asyncio
    async def test_render_produces_glb(self, minimal_threejs_code):
        state = self._state_with_code(minimal_threejs_code)
        result = await render_node(state)

        rendered_list: list[Artifact] = result["artifact_history"]
        rendered = next(a for a in rendered_list if a.version == "1")
        assert rendered.glb is not None, "render_node 應填入 glb"
        assert rendered.glb[:4] == b"glTF"

    @pytest.mark.asyncio
    async def test_render_produces_snapshot(self, minimal_threejs_code):
        state = self._state_with_code(minimal_threejs_code)
        result = await render_node(state)

        rendered_list: list[Artifact] = result["artifact_history"]
        rendered = next(a for a in rendered_list if a.version == "1")
        assert rendered.snapshot is not None
        assert rendered.snapshot[:4] == b"\x89PNG"

    @pytest.mark.asyncio
    async def test_render_sets_top_level_job_id(self, minimal_threejs_code):
        state = self._state_with_code(minimal_threejs_code)
        result = await render_node(state)
        assert result.get("job_id"), "render_node 應把 job_id 提升到 state 頂層"

    @pytest.mark.asyncio
    async def test_render_error_recorded_in_artifact(self):
        broken_code = "not valid JS @@@"
        state = self._state_with_code(broken_code)
        result = await render_node(state)

        rendered_list: list[Artifact] = result["artifact_history"]
        rendered = next(a for a in rendered_list if a.version == "1")
        assert rendered.errors, "broken code 應讓 artifact 記錄 error"
        assert rendered.glb is None


# ---------------------------------------------------------------------------
# review_node  (real LLM, snapshot provided)
# ---------------------------------------------------------------------------


@requires_llm
class TestReviewNodeLLM:
    @pytest.fixture
    def snapshot_png(self) -> bytes:
        """Tiny valid 1×1 white PNG so the LLM gets an actual image."""
        import base64
        # 1×1 white PNG, base64-encoded
        b64 = (
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
            "z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg=="
        )
        return base64.b64decode(b64)

    def _state_with_snapshot(self, snapshot: bytes) -> Craft3DState:
        artifact = Artifact(
            version="1",
            input=_INPUT,
            code="// code",
            snapshot=snapshot,
        )
        return _base_state(
            artifact_history=[artifact],
            current_version="1",
        )

    @pytest.mark.asyncio
    async def test_review_sets_review_on_artifact(self, snapshot_png):
        state = self._state_with_snapshot(snapshot_png)
        with patch(
            "agents_server.graphs.craft3d.nodes._debug_save_artifact",
            new=AsyncMock(),
        ):
            result = await review_node(state)

        reviewed_list: list[Artifact] = result["artifact_history"]
        reviewed = next(a for a in reviewed_list if a.version == "1")
        assert reviewed.review is not None, "LLM 應產生 review"
        assert isinstance(reviewed.review.approved, bool)
        assert reviewed.review.comment, "review comment 不應為空"

    @pytest.mark.asyncio
    async def test_no_snapshot_auto_rejects(self):
        """Artifact without snapshot should be rejected without calling the LLM."""
        artifact = Artifact(version="1", input=_INPUT, code="// code", snapshot=None)
        state = _base_state(
            artifact_history=[artifact],
            current_version="1",
        )
        with patch(
            "agents_server.graphs.craft3d.nodes._debug_save_artifact",
            new=AsyncMock(),
        ):
            result = await review_node(state)

        reviewed_list: list[Artifact] = result["artifact_history"]
        reviewed = next(a for a in reviewed_list if a.version == "1")
        assert reviewed.review is not None
        assert reviewed.review.approved is False
