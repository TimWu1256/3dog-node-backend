"""
Shared fixtures and skip-markers for integration tests.

Environment variables:
  GOOGLE_API_KEY   – required for any test that calls the Gemini LLM
  RENDER_GLB_URL   – override render server URL (default: http://localhost:3601/render)
"""

from __future__ import annotations

import os

import httpx
import pytest

_RENDER_URL = os.environ.get("RENDER_GLB_URL", "http://localhost:3601/render")
_RENDER_HEALTH = _RENDER_URL.rsplit("/render", 1)[0] + "/health"


def _render_server_is_up() -> bool:
    try:
        # Some servers expose /health; fall back to the render endpoint itself.
        for url in (_RENDER_HEALTH, _RENDER_URL):
            try:
                r = httpx.get(url, timeout=2)
                if r.status_code < 500:
                    return True
            except Exception:
                continue
        return False
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Marks – apply these to tests so pytest skips them when deps are absent.
# ---------------------------------------------------------------------------

requires_llm = pytest.mark.skipif(
    not os.environ.get("GOOGLE_API_KEY"),
    reason="GOOGLE_API_KEY 未設定，跳過 LLM 整合測試",
)

requires_render = pytest.mark.skipif(
    not _render_server_is_up(),
    reason=f"Render server 未回應 ({_RENDER_URL})，跳過 render 整合測試",
)

requires_both = pytest.mark.skipif(
    not os.environ.get("GOOGLE_API_KEY") or not _render_server_is_up(),
    reason="需要 GOOGLE_API_KEY 且 render server 正在執行",
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def simple_input():
    from agents_server.common.schemas import ObjectProps
    return ObjectProps(
        object_name="Wooden Crate",
        object_description="A simple wooden crate with visible planks and metal corners.",
    )


@pytest.fixture
def minimal_threejs_code() -> str:
    """Valid Three.js snippet that renders a plain box – fast and deterministic."""
    return """\
const geometry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshStandardMaterial({ color: 0x8b4513 });
const mesh = new THREE.Mesh(geometry, material);
scene.add(mesh);
"""
