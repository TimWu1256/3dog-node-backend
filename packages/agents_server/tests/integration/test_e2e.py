"""
Layer 3 – end-to-end integration tests.

Both services (Gemini LLM + render server) must be available.
Runs invoke_craft3d_agent with no mocks and verifies the final state.
"""

from __future__ import annotations

import pytest

from agents_server.common.schemas import ObjectProps
from agents_server.graphs.craft3d.graph import invoke_craft3d_agent
from agents_server.graphs.craft3d.state import Artifact
from tests.integration.conftest import requires_both


@requires_both
class TestE2E:
    @pytest.fixture
    def simple_input(self) -> ObjectProps:
        return ObjectProps(
            object_name="Wooden Crate",
            object_description="A simple wooden crate with visible planks.",
        )

    @pytest.mark.asyncio
    async def test_agent_completes_and_returns_artifact(self, simple_input):
        result = await invoke_craft3d_agent(simple_input)

        assert "current_artifact" in result
        artifact: Artifact | None = result["current_artifact"]
        assert artifact is not None, "最終 state 應有 current_artifact"

    @pytest.mark.asyncio
    async def test_artifact_has_code(self, simple_input):
        result = await invoke_craft3d_agent(simple_input)
        artifact: Artifact = result["current_artifact"]
        assert artifact.code, "artifact 應包含 LLM 產生的程式碼"

    @pytest.mark.asyncio
    async def test_artifact_has_glb(self, simple_input):
        result = await invoke_craft3d_agent(simple_input)
        artifact: Artifact = result["current_artifact"]
        assert artifact.glb is not None, "artifact 應有 GLB binary"
        assert artifact.glb[:4] == b"glTF", "GLB 應有正確的 magic bytes"

    @pytest.mark.asyncio
    async def test_artifact_has_snapshot(self, simple_input):
        result = await invoke_craft3d_agent(simple_input)
        artifact: Artifact = result["current_artifact"]
        assert artifact.snapshot is not None
        assert artifact.snapshot[:4] == b"\x89PNG"

    @pytest.mark.asyncio
    async def test_artifact_has_review(self, simple_input):
        result = await invoke_craft3d_agent(simple_input)
        artifact: Artifact = result["current_artifact"]
        assert artifact.review is not None, "artifact 應有 review 結果"
        assert isinstance(artifact.review.approved, bool)

    @pytest.mark.asyncio
    async def test_job_id_propagated_to_state(self, simple_input):
        result = await invoke_craft3d_agent(simple_input)
        assert result.get("job_id"), "job_id 應從 render_node 提升到 state 頂層"

    @pytest.mark.asyncio
    async def test_artifact_history_nonempty(self, simple_input):
        result = await invoke_craft3d_agent(simple_input)
        assert len(result["artifact_history"]) >= 1

    @pytest.mark.asyncio
    async def test_approved_or_hit_max_revises(self, simple_input):
        """Agent 應在 approved 或達到 MAX_REVISES 後停止。"""
        from agents_server.graphs.craft3d.edges import MAX_REVISES

        result = await invoke_craft3d_agent(simple_input)
        artifact: Artifact = result["current_artifact"]

        approved = artifact.review and artifact.review.approved
        hit_limit = result["revise_count"] >= MAX_REVISES
        assert approved or hit_limit, (
            f"Agent 應在 approved 或達到 {MAX_REVISES} 次修改後結束，"
            f"實際: approved={approved}, revise_count={result['revise_count']}"
        )
