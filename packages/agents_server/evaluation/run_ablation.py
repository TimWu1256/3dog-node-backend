"""
Ablation study batch runner for craft3d prompt constraint mechanisms.

Usage (from packages/agents_server/):
    uv run python -m evaluation.run_ablation --conditions C0 C1 C2 C3 --repeats 3
    uv run python -m evaluation.run_ablation --conditions C0 C1 --difficulty simple --repeats 1
    uv run python -m evaluation.run_ablation --conditions C0 --difficulty complex --timeout-ms 120000

Results are written to evaluation/results/raw_<timestamp>.jsonl, one JSON record per line.
Each record contains per-artifact version details (errors, review) extracted from artifact_history.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ablation")

_HERE = Path(__file__).parent
_PROMPTS_FILE = _HERE / "prompts.jsonl"
_RESULTS_DIR = _HERE / "results"
_V3_TEMPLATE = Path(__file__).resolve().parents[3] / "instructions" / "craft3d-generation-v3.md"

_DEFAULT_CONDITIONS = ["C0", "C1", "C2", "C3"]
_DEFAULT_MAX_REVIEWS = 1   # no revision: review ends graph regardless of result
_DEFAULT_BATCH_SIZE = 3    # concurrent prompts per condition (I/O bound, no monkeypatch conflict)
_FIXED_CRAFT_MODEL = "google/gemini-3-flash-preview"


# ---------------------------------------------------------------------------
# Lazy imports (deferred so env vars can be set before SDK init)
# ---------------------------------------------------------------------------


def _import_agent():
    from agents_server.graphs.craft3d.graph import craft3d_agent  # type: ignore[import]
    return craft3d_agent


def _import_nodes():
    import agents_server.graphs.craft3d.nodes as nodes_module  # type: ignore[import]
    return nodes_module


def _import_schemas():
    from agents_server.common.schemas import ObjectProps  # type: ignore[import]
    return ObjectProps


# ---------------------------------------------------------------------------
# Prompt loading
# ---------------------------------------------------------------------------


def load_prompts(
    path: Path = _PROMPTS_FILE,
    difficulties: list[str] | None = None,
) -> list[dict]:
    prompts = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if difficulties and obj.get("difficulty") not in difficulties:
                continue
            prompts.append(obj)
    return prompts


# ---------------------------------------------------------------------------
# Result extraction
# ---------------------------------------------------------------------------


def _classify_error(msg: str) -> str:
    """Map a raw error string to a canonical error category."""
    if not msg:
        return "none"
    m = msg.lower()
    if "__export() was never called" in m:
        return "no_export"
    if "timeout" in m:
        return "timeout"
    if "import" in m or "require" in m or "cannot use import" in m:
        return "import_error"
    if "is not defined" in m:
        return "reference_error"
    if "is not a function" in m or "typeerror" in m:
        return "type_error"
    if "syntaxerror" in m or "unexpected token" in m or "unexpected end" in m:
        return "syntax_error"
    return "other"


def _serialize_artifact(artifact: Any) -> dict:
    """Extract serializable fields from an Artifact model (skip bytes fields)."""
    errors: list[str] = artifact.errors or []
    error_types = [_classify_error(e) for e in errors]
    review = artifact.review
    return {
        "version": artifact.version,
        "has_error": len(errors) > 0,
        "errors": errors,
        "error_types": error_types,
        "review_approved": review.approved if review else None,
        "review_comment": (review.comment[:500] if review else None),  # truncate for storage
    }


def _extract_result(
    prompt: dict,
    condition: str,
    repeat: int,
    final_state: dict | None,
    elapsed_s: float,
) -> dict:
    """Build a structured result record from the final LangGraph state."""
    artifacts = []
    first_pass_error = True
    final_error = True
    revision_count = 0
    failure_reason = None
    job_id = ""

    if final_state:
        history: list = final_state.get("artifact_history") or []
        artifacts = [_serialize_artifact(a) for a in history]
        revision_count = max(0, len(artifacts) - 1)

        if artifacts:
            # v1 = first attempt; final = last in history
            first_pass_error = artifacts[0]["has_error"]
            final_error = artifacts[-1]["has_error"]

        failure_reason = final_state.get("failure_reason")
        job_id = final_state.get("job_id") or ""

    return {
        "prompt": {
            "object_name": prompt["object_name"],
            "object_description": prompt["object_description"],
            "difficulty": prompt.get("difficulty", "unknown"),
        },
        "condition": condition,
        "repeat": repeat,
        "elapsed_s": round(elapsed_s, 2),
        "job_id": job_id,
        "failure_reason": failure_reason,
        "first_pass_error": first_pass_error,
        "final_error": final_error,
        "revision_count": revision_count,
        "artifacts": artifacts,
    }


# ---------------------------------------------------------------------------
# Core execution
# ---------------------------------------------------------------------------


async def _run_prompt(
    prompt: dict,
    condition: str,
    repeat: int,
    max_reviews: int,
    timeout_ms: int,
    craft3d_agent: Any,
    ObjectProps: Any,
) -> dict:
    """Execute craft3d_agent on one prompt. Monkeypatch must already be in place."""
    t0 = time.perf_counter()
    final_state: dict | None = None
    try:
        async for state in craft3d_agent.astream(
            {
                "input": ObjectProps(
                    object_name=prompt["object_name"],
                    object_description=prompt["object_description"],
                ),
                "max_reviews": max_reviews,
                "model": _FIXED_CRAFT_MODEL,
            },
            stream_mode="values",
        ):
            final_state = state
    except Exception as exc:
        log.warning("Agent raised during %s/%s: %s", condition, prompt["object_name"], exc)
    elapsed = time.perf_counter() - t0
    return _extract_result(prompt, condition, repeat, final_state, elapsed)


async def run_condition(
    condition: str,
    prompts: list[dict],
    repeat: int,
    max_reviews: int,
    timeout_ms: int,
    batch_size: int,
    craft3d_agent: Any,
    nodes_module: Any,
    ObjectProps: Any,
) -> list[dict]:
    """Run all prompts for one ablation condition (monkeypatched), in batches."""
    from evaluation.prompt_variants import make_variant  # type: ignore[import]

    variant_fn = make_variant(condition, _V3_TEMPLATE)
    original_fn = nodes_module._render_generation_prompt
    nodes_module._render_generation_prompt = variant_fn
    log.info("[%s] monkeypatched _render_generation_prompt", condition)

    results = []
    try:
        for batch_start in range(0, len(prompts), batch_size):
            batch = prompts[batch_start: batch_start + batch_size]
            log.info(
                "[%s] repeat=%d batch %d-%d / %d",
                condition, repeat, batch_start + 1, batch_start + len(batch), len(prompts),
            )
            batch_results = await asyncio.gather(
                *[
                    _run_prompt(p, condition, repeat, max_reviews, timeout_ms, craft3d_agent, ObjectProps)
                    for p in batch
                ],
                return_exceptions=False,
            )
            results.extend(batch_results)
            # Log per-prompt outcomes
            for r in batch_results:
                status = "OK" if not r["final_error"] else f"ERR({r['artifacts'][-1]['error_types'] if r['artifacts'] else '?'})"
                log.info(
                    "  [%s] %s -> first_pass_err=%s final_err=%s revisions=%d %s (%.1fs)",
                    condition, r["prompt"]["object_name"],
                    r["first_pass_error"], r["final_error"], r["revision_count"],
                    status, r["elapsed_s"],
                )
    finally:
        nodes_module._render_generation_prompt = original_fn
        log.info("[%s] restored _render_generation_prompt", condition)

    return results


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def main(args: argparse.Namespace) -> None:
    _RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    prompts = load_prompts(
        Path(args.prompts_file),
        difficulties=args.difficulty or None,
    )
    if not prompts:
        log.error("No prompts matched the given filters. Check --difficulty and --prompts-file.")
        return
    log.info("Loaded %d prompts (difficulties: %s)", len(prompts), args.difficulty or "all")

    # Lazy imports after env is ready
    craft3d_agent = _import_agent()
    nodes_module = _import_nodes()
    ObjectProps = _import_schemas()

    timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output_path = _RESULTS_DIR / f"raw_{timestamp}.jsonl"
    log.info("Writing results to %s", output_path)

    all_results = []
    for repeat in range(args.repeats):
        log.info("=== Repeat %d / %d ===", repeat + 1, args.repeats)
        for condition in args.conditions:
            results = await run_condition(
                condition=condition,
                prompts=prompts,
                repeat=repeat,
                max_reviews=args.max_reviews,
                timeout_ms=args.timeout_ms,
                batch_size=args.batch_size,
                craft3d_agent=craft3d_agent,
                nodes_module=nodes_module,
                ObjectProps=ObjectProps,
            )
            all_results.extend(results)
            # Flush after each condition to preserve partial results
            with output_path.open("a", encoding="utf-8") as f:
                for r in results:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")
            log.info("[%s] repeat=%d saved %d records", condition, repeat, len(results))

    log.info("Done. Total records: %d. Output: %s", len(all_results), output_path)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Ablation study runner for craft3d prompt constraint mechanisms.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--conditions", nargs="+", default=_DEFAULT_CONDITIONS,
        metavar="COND",
        help="Ablation conditions to run. Valid: C0 C1 C2 C3 C4",
    )
    p.add_argument(
        "--max-reviews", type=int, default=_DEFAULT_MAX_REVIEWS,
        help="max_reviews passed to craft3d_agent (fixed backstop). 2 = 1 revision attempt.",
    )
    p.add_argument(
        "--repeats", type=int, default=1,
        help="Number of times to repeat the full benchmark (for averaging over LLM randomness).",
    )
    p.add_argument(
        "--prompts-file", default=str(_PROMPTS_FILE),
        help="Path to the JSONL prompts dataset.",
    )
    p.add_argument(
        "--difficulty", nargs="+", choices=["simple", "medium", "complex"],
        default=None, metavar="LEVEL",
        help="Filter prompts by difficulty level. Default: all levels.",
    )
    p.add_argument(
        "--timeout-ms", type=int, default=10_000,
        help="Render timeout in milliseconds passed to the craft3d service.",
    )
    p.add_argument(
        "--batch-size", type=int, default=_DEFAULT_BATCH_SIZE,
        help="Number of prompts to run concurrently within each condition.",
    )
    return p


if __name__ == "__main__":
    args = _build_parser().parse_args()
    asyncio.run(main(args))
