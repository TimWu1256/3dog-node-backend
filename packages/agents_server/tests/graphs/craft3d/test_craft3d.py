"""
Tests for the craft3d graph – state models, edge routers, nodes, and graph integration.
All external I/O (LLM calls, render_glb) is mocked.
"""

from __future__ import annotations

import base64
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langgraph.graph import END

from agents_server.common.schemas import ObjectProps
from agents_server.graphs.craft3d.edges import MAX_REVISES, review_router
from agents_server.graphs.craft3d.graph import invoke_craft3d_agent
from agents_server.graphs.craft3d.nodes import (
    craft_node,
    render_node,
    review_node,
    revise_node,
)
from agents_server.graphs.craft3d.state import (
    Artifact,
    Craft3DState,
    Review,
    _artifact_history_reducer,
    _revise_count_reducer,
    get_current_artifact,
    replace_artifact_in_history,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_INPUT = ObjectProps(object_name="Tree", object_description="A small oak tree")


def _make_artifact(
    version: str = "1",
    *,
    code: Optional[str] = "// code",
    glb: Optional[bytes] = None,
    snapshot: Optional[bytes] = None,
    errors: list[str] | None = None,
    review: Optional[Review] = None,
) -> Artifact:
    return Artifact(
        version=version,
        input=_INPUT,
        code=code,
        glb=glb,
        snapshot=snapshot,
        errors=errors or [],
        review=review,
    )


def _make_state(
    *,
    artifacts: list[Artifact] | None = None,
    current_version: Optional[str] = None,
    revise_count: int = 0,
) -> Craft3DState:
    return {
        "input": _INPUT,
        "artifact_history": artifacts or [],
        "current_version": current_version,
        "revise_count": revise_count,
        "job_id": "",
    }


# ===========================================================================
# State – data models
# ===========================================================================


class TestArtifactSerialization:
    def test_bytes_stored_as_bytes(self):
        raw = b"\x89PNG"
        a = _make_artifact(glb=raw, snapshot=raw)
        assert a.glb == raw
        assert a.snapshot == raw

    def test_base64_string_decoded_on_construction(self):
        raw = b"\x89PNG"
        b64 = base64.b64encode(raw).decode()
        a = Artifact(version="1", input=_INPUT, glb=b64, snapshot=b64)
        assert a.glb == raw
        assert a.snapshot == raw

    def test_serialisation_round_trip(self):
        raw = b"\x00\x01\x02"
        a = _make_artifact(glb=raw, snapshot=raw)
        data = a.model_dump(mode="json")
        assert isinstance(data["glb"], str)
        restored = Artifact.model_validate(data)
        assert restored.glb == raw
        assert restored.snapshot == raw

    def test_none_bytes_stays_none(self):
        a = _make_artifact(glb=None, snapshot=None)
        data = a.model_dump(mode="json")
        assert data["glb"] is None
        assert data["snapshot"] is None

    def test_copy_with_overrides_fields(self):
        a = _make_artifact(version="1", errors=[])
        b = a.copy_with(errors=["oops"])
        assert b.errors == ["oops"]
        assert a.errors == []  # original unchanged


class TestReducers:
    def test_artifact_history_reducer_appends_single(self):
        a1 = _make_artifact("1")
        a2 = _make_artifact("2")
        result = _artifact_history_reducer([a1], a2)
        assert len(result) == 2
        assert result[-1].version == "2"

    def test_artifact_history_reducer_replaces_on_list(self):
        a1 = _make_artifact("1")
        a2 = _make_artifact("2")
        result = _artifact_history_reducer([a1], [a2])
        assert result == [a2]

    def test_artifact_history_reducer_coerces_dict(self):
        a1 = _make_artifact("1")
        a2_dict = _make_artifact("2").model_dump()
        result = _artifact_history_reducer([a1], a2_dict)
        assert isinstance(result[-1], Artifact)
        assert result[-1].version == "2"

    def test_revise_count_reducer_accumulates(self):
        assert _revise_count_reducer(0, 1) == 1
        assert _revise_count_reducer(3, 2) == 5


class TestGetCurrentArtifact:
    def test_returns_none_when_no_version(self):
        state = _make_state()
        assert get_current_artifact(state) is None

    def test_returns_matching_artifact(self):
        a1 = _make_artifact("1")
        a2 = _make_artifact("2")
        state = _make_state(artifacts=[a1, a2], current_version="1")
        result = get_current_artifact(state)
        assert result is not None
        assert result.version == "1"

    def test_returns_none_when_version_missing_from_history(self):
        a1 = _make_artifact("1")
        state = _make_state(artifacts=[a1], current_version="99")
        assert get_current_artifact(state) is None

    def test_prefers_last_matching_version(self):
        a1 = _make_artifact("1")
        a1b = _make_artifact("1")
        a1b = a1b.copy_with(code="// newer")
        state = _make_state(artifacts=[a1, a1b], current_version="1")
        result = get_current_artifact(state)
        assert result is not None
        assert result.code == "// newer"


class TestReplaceArtifactInHistory:
    def test_replaces_matching_version(self):
        a1 = _make_artifact("1")
        a2 = _make_artifact("2")
        updated = a1.copy_with(code="// updated")
        result = replace_artifact_in_history([a1, a2], updated)
        assert result[0].code == "// updated"
        assert result[1].code == a2.code

    def test_no_match_leaves_list_unchanged(self):
        a1 = _make_artifact("1")
        orphan = _make_artifact("99")
        result = replace_artifact_in_history([a1], orphan)
        assert result[0].version == "1"


# ===========================================================================
# Edges – review_router
# ===========================================================================


class TestReviewRouter:
    def _state(self, *, approved: bool, revise_count: int = 0) -> Craft3DState:
        a = _make_artifact("1", review=Review(approved=approved, comment="ok"))
        return _make_state(artifacts=[a], current_version="1", revise_count=revise_count)

    def test_approved_returns_end(self):
        assert review_router(self._state(approved=True)) == END

    def test_not_approved_returns_revise_node(self):
        assert review_router(self._state(approved=False)) == "revise_node"

    def test_max_revises_reached_returns_end(self):
        assert review_router(self._state(approved=False, revise_count=MAX_REVISES)) == END

    def test_no_artifact_raises(self):
        state = _make_state()  # no current_version
        with pytest.raises(ValueError, match="No artifact"):
            review_router(state)

    def test_no_review_raises(self):
        a = _make_artifact("1", review=None)
        state = _make_state(artifacts=[a], current_version="1")
        with pytest.raises(ValueError, match="No review"):
            review_router(state)


# ===========================================================================
# Nodes (external dependencies mocked)
# ===========================================================================


class TestCraftNode:
    @pytest.mark.asyncio
    async def test_returns_artifact_and_version(self):
        artifact = _make_artifact("1")
        with patch(
            "agents_server.graphs.craft3d.nodes._create_artifact",
            new=AsyncMock(return_value=artifact),
        ):
            result = await craft_node(_make_state())

        assert result["current_version"] == "1"
        assert result["artifact_history"] is artifact

    @pytest.mark.asyncio
    async def test_version_increments_with_history(self):
        existing = _make_artifact("1")
        state = _make_state(artifacts=[existing], current_version="1")
        new_artifact = _make_artifact("2")

        with patch(
            "agents_server.graphs.craft3d.nodes._create_artifact",
            new=AsyncMock(return_value=new_artifact),
        ) as mock:
            await craft_node(state)
            call_kwargs = mock.call_args.kwargs
            assert call_kwargs["version"] == "2"


class TestRenderNode:
    @pytest.mark.asyncio
    async def test_renders_current_artifact(self):
        a = _make_artifact("1")
        state = _make_state(artifacts=[a], current_version="1")
        rendered = a.copy_with(glb=b"\x00", snapshot=b"\x01", job_id="job-42")

        with patch(
            "agents_server.graphs.craft3d.nodes._render_artifact",
            new=AsyncMock(return_value=rendered),
        ):
            result = await render_node(state)

        assert result["job_id"] == "job-42"
        assert any(
            art.job_id == "job-42" for art in result["artifact_history"]
        )

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_current(self):
        state = _make_state()
        result = await render_node(state)
        assert result == {}

    @pytest.mark.asyncio
    async def test_skips_job_id_key_when_empty(self):
        a = _make_artifact("1")
        state = _make_state(artifacts=[a], current_version="1")
        rendered = a.copy_with(job_id="")

        with patch(
            "agents_server.graphs.craft3d.nodes._render_artifact",
            new=AsyncMock(return_value=rendered),
        ):
            result = await render_node(state)

        assert "job_id" not in result


class TestReviewNode:
    @pytest.mark.asyncio
    async def test_updates_history_with_review(self):
        a = _make_artifact("1", snapshot=b"\x89PNG")
        state = _make_state(artifacts=[a], current_version="1")
        reviewed = a.copy_with(review=Review(approved=True, comment="Great"))

        with (
            patch(
                "agents_server.graphs.craft3d.nodes._review_artifact",
                new=AsyncMock(return_value=reviewed),
            ),
            patch(
                "agents_server.graphs.craft3d.nodes._debug_save_artifact",
                new=AsyncMock(),
            ),
        ):
            result = await review_node(state)

        arts = result["artifact_history"]
        assert any(art.review and art.review.approved for art in arts)

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_current(self):
        state = _make_state()
        result = await review_node(state)
        assert result == {}


class TestReviseNode:
    @pytest.mark.asyncio
    async def test_creates_new_version_with_revision(self):
        review = Review(approved=False, comment="Needs work")
        a = _make_artifact("1", review=review)
        state = _make_state(artifacts=[a], current_version="1", revise_count=0)
        new_artifact = _make_artifact("2")

        with patch(
            "agents_server.graphs.craft3d.nodes._create_artifact",
            new=AsyncMock(return_value=new_artifact),
        ):
            result = await revise_node(state)

        assert result["current_version"] == "2"
        assert result["revise_count"] == 1

    @pytest.mark.asyncio
    async def test_raises_when_no_current(self):
        state = _make_state()
        with pytest.raises(ValueError, match="No current artifact"):
            await revise_node(state)


# ===========================================================================
# Graph – invoke_craft3d_agent
# ===========================================================================


class TestInvokeCraft3dAgent:
    @pytest.mark.asyncio
    async def test_returns_final_state_with_current_artifact(self):
        review = Review(approved=True, comment="APPROVED")
        artifact = _make_artifact("1", review=review, snapshot=b"\x89PNG")

        final_state: Craft3DState = {
            "input": _INPUT,
            "artifact_history": [artifact],
            "current_version": "1",
            "revise_count": 0,
            "job_id": "job-1",
        }

        async def _fake_astream(initial, **kwargs):
            yield ("updates", {"craft_node": {"artifact_history": artifact}})
            yield ("values", final_state)

        with patch(
            "agents_server.graphs.craft3d.graph.craft3d_agent.astream",
            side_effect=_fake_astream,
        ):
            result = await invoke_craft3d_agent(_INPUT)

        assert result["current_version"] == "1"
        assert result["current_artifact"] is not None
        assert result["current_artifact"].version == "1"

    @pytest.mark.asyncio
    async def test_current_artifact_none_when_no_version(self):
        final_state: Craft3DState = {
            "input": _INPUT,
            "artifact_history": [],
            "current_version": None,
            "revise_count": 0,
            "job_id": "",
        }

        async def _fake_astream(initial, **kwargs):
            yield ("values", final_state)

        with patch(
            "agents_server.graphs.craft3d.graph.craft3d_agent.astream",
            side_effect=_fake_astream,
        ):
            result = await invoke_craft3d_agent(_INPUT)

        assert result["current_artifact"] is None


# ===========================================================================
# Graph structure smoke test
# ===========================================================================


class TestGraphStructure:
    def test_graph_has_expected_nodes(self):
        from agents_server.graphs.craft3d.graph import craft3d_agent

        node_names = set(craft3d_agent.nodes.keys())
        for expected in {"craft_node", "render_node", "review_node", "revise_node"}:
            assert expected in node_names, f"Missing node: {expected}"
