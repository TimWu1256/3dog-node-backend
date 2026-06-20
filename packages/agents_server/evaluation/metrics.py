"""
Ablation study metrics aggregator.

Reads raw_*.jsonl files produced by run_ablation.py and outputs:
  - results/summary_<timestamp>.csv   — machine-readable aggregate table
  - results/summary_<timestamp>.md    — Markdown table for thesis appendix

Usage (from packages/agents_server/):
    uv run python -m evaluation.metrics
    uv run python -m evaluation.metrics --input evaluation/results/raw_20250614T*.jsonl
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import logging
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

_HERE = Path(__file__).parent
_RESULTS_DIR = _HERE / "results"

_ALL_CONDITIONS = ["C0", "C1", "C2", "C3", "C4"]
_ALL_ERROR_TYPES = [
    "import_error", "reference_error", "type_error",
    "syntax_error", "no_export", "timeout", "other",
]


def _classify_error(msg: str) -> str:
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
    if "is not a function" in m or "is not a constructor" in m or "typeerror" in m:
        return "type_error"
    if "syntaxerror" in m or "unexpected token" in m or "unexpected end" in m or "has already been declared" in m:
        return "syntax_error"
    return "other"

# Human-readable labels for conditions
_CONDITION_LABELS = {
    "C0": "Full prompt (baseline)",
    "C1": "w/o Sandbox context (rules 1-2: NO IMPORTS, NO DOM)",
    "C2": "w/o Forbidden APIs (rules 3-4: NO ASSETS, NO CONTROLS)",
    "C3": "w/o Procedural craft (rules 5-6: TEXTURES, SEMANTIC NAMES)",
    "C4": "w/o Hallucination guard (rule 7: NO INVENTED METHODS)",
}


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------


def load_records(paths: list[Path]) -> list[dict]:
    records = []
    for path in paths:
        with path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
    log.info("Loaded %d records from %d file(s)", len(records), len(paths))
    return records


# ---------------------------------------------------------------------------
# Per-condition aggregation
# ---------------------------------------------------------------------------


def _collect_error_types_for_version(artifacts: list[dict], version_idx: int) -> list[str]:
    """Re-classify errors from raw strings for a specific artifact version (0 = first, -1 = last)."""
    if not artifacts:
        return []
    artifact = artifacts[version_idx]
    errors: list[str] = artifact.get("errors") or []
    return [_classify_error(e) for e in errors]


def aggregate(records: list[dict]) -> dict[str, dict]:
    """Compute per-condition statistics. Returns {condition: stats_dict}."""
    # Group records by condition
    by_condition: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        by_condition[r["condition"]].append(r)

    results = {}
    for condition, items in sorted(by_condition.items()):
        n = len(items)

        # First-pass error rate (v1 artifact)
        first_pass_errors = sum(1 for r in items if r.get("first_pass_error", True))

        # Final error rate (after revise loop)
        final_errors = sum(1 for r in items if r.get("final_error", True))

        # Revision count
        revision_counts = [r.get("revision_count", 0) for r in items]
        avg_revisions = sum(revision_counts) / n if n else 0

        # Elapsed time
        elapsed_vals = [r.get("elapsed_s", 0.0) for r in items]
        avg_elapsed = sum(elapsed_vals) / n if n else 0

        # Approval rate (final artifact review approved)
        approved_count = 0
        for r in items:
            arts = r.get("artifacts") or []
            if arts and arts[-1].get("review_approved") is True:
                approved_count += 1

        # First-pass error type distribution
        first_type_counts: dict[str, int] = defaultdict(int)
        for r in items:
            arts = r.get("artifacts") or []
            types = _collect_error_types_for_version(arts, 0) if arts else []
            for t in types:
                first_type_counts[t] += 1

        results[condition] = {
            "n": n,
            "first_pass_error_rate": first_pass_errors / n if n else 0,
            "final_error_rate": final_errors / n if n else 0,
            "avg_revisions": round(avg_revisions, 3),
            "avg_elapsed_s": round(avg_elapsed, 1),
            "approval_rate": round(approved_count / n, 3) if n else 0,
            "first_pass_error_count": first_pass_errors,
            "final_error_count": final_errors,
            "first_pass_error_types": dict(first_type_counts),
        }

    return results


# ---------------------------------------------------------------------------
# Detailed per-difficulty breakdown
# ---------------------------------------------------------------------------


def aggregate_by_difficulty(records: list[dict]) -> dict[str, dict[str, dict]]:
    """Returns {condition: {difficulty: stats}}."""
    by_cond_diff: dict[str, dict[str, list]] = defaultdict(lambda: defaultdict(list))
    for r in records:
        by_cond_diff[r["condition"]][r["prompt"].get("difficulty", "unknown")].append(r)

    result: dict[str, dict[str, dict]] = {}
    for cond, by_diff in by_cond_diff.items():
        result[cond] = {}
        for diff, items in by_diff.items():
            n = len(items)
            first_errors = sum(1 for r in items if r.get("first_pass_error", True))
            final_errors = sum(1 for r in items if r.get("final_error", True))
            result[cond][diff] = {
                "n": n,
                "first_pass_error_rate": round(first_errors / n, 3) if n else 0,
                "final_error_rate": round(final_errors / n, 3) if n else 0,
            }
    return result


# ---------------------------------------------------------------------------
# CSV export
# ---------------------------------------------------------------------------


def write_csv(stats: dict[str, dict], path: Path) -> None:
    fieldnames = [
        "condition", "label", "n",
        "first_pass_error_rate", "final_error_rate",
        "avg_revisions", "avg_elapsed_s", "approval_rate",
    ] + [f"first_err_{t}" for t in _ALL_ERROR_TYPES]

    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for condition in _ALL_CONDITIONS:
            if condition not in stats:
                continue
            s = stats[condition]
            row = {
                "condition": condition,
                "label": _CONDITION_LABELS.get(condition, condition),
                "n": s["n"],
                "first_pass_error_rate": f"{s['first_pass_error_rate']:.3f}",
                "final_error_rate": f"{s['final_error_rate']:.3f}",
                "avg_revisions": f"{s['avg_revisions']:.3f}",
                "avg_elapsed_s": f"{s['avg_elapsed_s']:.1f}",
                "approval_rate": f"{s['approval_rate']:.3f}",
            }
            etypes = s.get("first_pass_error_types") or {}
            for t in _ALL_ERROR_TYPES:
                row[f"first_err_{t}"] = etypes.get(t, 0)
            writer.writerow(row)

    log.info("CSV written: %s", path)


# ---------------------------------------------------------------------------
# Markdown export
# ---------------------------------------------------------------------------


def _pct(v: float) -> str:
    return f"{v * 100:.1f}%"


def write_markdown(
    stats: dict[str, dict],
    diff_stats: dict[str, dict[str, dict]],
    path: Path,
    input_paths: list[Path],
) -> None:
    ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "# Ablation Study Results",
        "",
        f"Generated: {ts}  ",
        f"Input files: {', '.join(p.name for p in input_paths)}",
        "",
        "## Main Results",
        "",
        "| Condition | Description | N | First-pass Error ↓ | Final Error ↓ | Avg Revisions | Avg Time (s) | Approval ↑ |",
        "|---|---|---|---|---|---|---|---|",
    ]

    for condition in _ALL_CONDITIONS:
        if condition not in stats:
            continue
        s = stats[condition]
        label = _CONDITION_LABELS.get(condition, condition)
        lines.append(
            f"| **{condition}** | {label} | {s['n']} "
            f"| {_pct(s['first_pass_error_rate'])} "
            f"| {_pct(s['final_error_rate'])} "
            f"| {s['avg_revisions']:.2f} "
            f"| {s['avg_elapsed_s']:.1f} "
            f"| {_pct(s['approval_rate'])} |"
        )

    lines += [
        "",
        "> **First-pass Error**: % of runs where v1 generated code had execution errors (before revise loop).  ",
        "> **Final Error**: % of runs still failing after the revise backstop.  ",
        "> **Approval**: % approved by the LLM visual reviewer (quality proxy).",
        "",
        "## First-pass Error Type Breakdown",
        "",
        "| Condition | import_error | reference_error | type_error | syntax_error | no_export | timeout | other |",
        "|---|---|---|---|---|---|---|---|",
    ]

    for condition in _ALL_CONDITIONS:
        if condition not in stats:
            continue
        etypes = stats[condition].get("first_pass_error_types") or {}
        n = stats[condition]["n"]
        def _fmt(t: str) -> str:
            count = etypes.get(t, 0)
            pct = count / n * 100 if n else 0
            return f"{count} ({pct:.0f}%)"
        lines.append(
            f"| **{condition}** | "
            + " | ".join(_fmt(t) for t in _ALL_ERROR_TYPES)
            + " |"
        )

    # Difficulty breakdown
    if diff_stats:
        lines += ["", "## Breakdown by Difficulty", ""]
        for difficulty in ["simple", "medium", "complex"]:
            has_data = any(
                difficulty in diff_stats.get(c, {})
                for c in _ALL_CONDITIONS
            )
            if not has_data:
                continue
            lines += [
                f"### {difficulty.capitalize()}",
                "",
                "| Condition | N | First-pass Error | Final Error |",
                "|---|---|---|---|",
            ]
            for condition in _ALL_CONDITIONS:
                d = diff_stats.get(condition, {}).get(difficulty)
                if d is None:
                    continue
                lines.append(
                    f"| **{condition}** | {d['n']} "
                    f"| {_pct(d['first_pass_error_rate'])} "
                    f"| {_pct(d['final_error_rate'])} |"
                )
            lines.append("")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    log.info("Markdown written: %s", path)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main(args: argparse.Namespace) -> None:
    if args.input:
        input_paths = sorted(Path(p) for p in args.input)
    else:
        # Default: all raw_*.jsonl in results dir
        input_paths = sorted(_RESULTS_DIR.glob("raw_*.jsonl"))

    if not input_paths:
        log.error(
            "No input files found. Run run_ablation.py first, or pass --input <paths>."
        )
        return

    records = load_records(input_paths)
    if not records:
        log.error("All input files are empty.")
        return

    stats = aggregate(records)
    diff_stats = aggregate_by_difficulty(records)

    # Print summary to console
    print("\n=== Ablation Study Summary ===\n")
    print(f"{'Condition':<6}  {'Description':<38}  {'N':>4}  {'1st-err':>7}  {'Final':>7}  {'Revs':>5}  {'Time':>7}")
    print("-" * 80)
    for condition in _ALL_CONDITIONS:
        if condition not in stats:
            continue
        s = stats[condition]
        print(
            f"{condition:<6}  {_CONDITION_LABELS.get(condition, ''):<38}  "
            f"{s['n']:>4}  {_pct(s['first_pass_error_rate']):>7}  "
            f"{_pct(s['final_error_rate']):>7}  {s['avg_revisions']:>5.2f}  "
            f"{s['avg_elapsed_s']:>6.1f}s"
        )
    print()

    # Write outputs — use the timestamp from the input filename(s) for traceability
    # e.g. raw_20260619T093816Z.jsonl → summary_20260619T093816Z.csv
    import re as _re
    ts_candidates = [_re.search(r"\d{8}T\d{6}Z", p.name) for p in input_paths]
    ts_matches = [m.group() for m in ts_candidates if m]
    ts = min(ts_matches) if ts_matches else datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    _RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    write_csv(stats, _RESULTS_DIR / f"summary_{ts}.csv")
    write_markdown(stats, diff_stats, _RESULTS_DIR / f"summary_{ts}.md", input_paths)

    log.info("Done. Summary files in %s", _RESULTS_DIR)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Aggregate ablation results from raw_*.jsonl and export CSV + Markdown.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--input", nargs="+", metavar="FILE",
        help="Explicit list of raw_*.jsonl files to aggregate. "
             "Defaults to all raw_*.jsonl in evaluation/results/.",
    )
    return p


if __name__ == "__main__":
    main(_build_parser().parse_args())
