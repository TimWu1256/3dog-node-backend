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
import json
import logging
import re
from collections import defaultdict
from datetime import datetime, timezone
from math import comb
from pathlib import Path

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

_HERE = Path(__file__).parent
_RESULTS_DIR = _HERE / "results"

_ALL_CONDITIONS = ["C0", "C1", "C2", "C3", "C4", "C5"]
_ALL_ERROR_TYPES = [
    "import_error", "reference_error", "type_error", "syntax_error",
    "range_error", "no_export", "no_code", "timeout", "other",
]


def _classify_error(msg: str) -> str:
    if not msg:
        return "none"
    m = msg.lower()
    if "__export() was never called" in m:
        return "no_export"
    if "no code to generate" in m:
        return "no_code"
    if "timeout" in m:
        return "timeout"
    if "import" in m or "require" in m or "cannot use import" in m:
        return "import_error"
    if "is not defined" in m:
        return "reference_error"
    if (
        "is not a function" in m or "is not a constructor" in m or "typeerror" in m
        or "cannot read propert" in m or "cannot set propert" in m
    ):
        return "type_error"
    if "outside the bounds" in m or "out of bounds" in m:
        return "range_error"
    if "syntaxerror" in m or "unexpected token" in m or "unexpected end" in m or "has already been declared" in m:
        return "syntax_error"
    return "other"


# ---------------------------------------------------------------------------
# Constraint-violation detection (static scan of generated code)
#
# Each ablation condition removes a rule group from the prompt. The most
# sensitive way to measure a rule's effect is to scan the *generated code* for
# the construct it forbids — many violations (DOM access silently ignored by the
# sandbox, generic node names, stripped imports) never crash, so they are
# invisible to execution-error rate but detectable statically.
# ---------------------------------------------------------------------------

# Object3D subclasses whose instances must receive a semantic .name (rule 6).
_OBJECT3D_CTORS = (
    "Mesh", "Group", "Points", "InstancedMesh", "SkinnedMesh",
    "Sprite", "Line", "LineSegments", "PerspectiveCamera",
    "OrthographicCamera", "DirectionalLight", "PointLight", "SpotLight",
)

_RE_OBJECT3D_NEW = re.compile(
    r"new\s+THREE\.(?:" + "|".join(_OBJECT3D_CTORS) + r")\b"
)
_RE_NAME_ASSIGN = re.compile(r"\.name\s*=")
_RE_GENERIC_NAME = re.compile(
    r"""\.name\s*=\s*["'](?:mesh|group|object|node|line|points|sprite|"""
    r"""object_?\d+|group_?\d+|node_?\d+|mesh_?\d+)\d*["']""",
    re.IGNORECASE,
)

_RE_SANDBOX = re.compile(
    r"""(?:^|\n)\s*import\s|[^.\w]require\s*\(|\bdocument\.|\bwindow\.|"""
    r"""\bnew\s+Image\s*\(|\bnew\s+Blob\s*\(|\bHTMLCanvasElement\b|"""
    r"""\bdocument\b\s*\[""",
)
_RE_FORBIDDEN_API = re.compile(
    r"""\bTextureLoader\b|\bGLTFLoader\b|\bFileLoader\b|\bImageLoader\b|"""
    r"""\bOrbitControls\b|https?://""",
)
_RE_IMAGE_TEXTURE = re.compile(
    r"""\bTextureLoader\b|\bCanvasTexture\b|\bImageLoader\b|\.map\s*="""
)


def detect_violations(code: str | None) -> dict[str, bool]:
    """Statically scan generated code for each constraint group's forbidden construct.

    Returns boolean flags keyed by violation category. An empty/missing code
    string yields all-False (no signal) — callers treat that separately from n/a.
    """
    if not code:
        return {"sandbox": False, "forbidden_api": False, "image_texture": False, "naming": False}

    n_objects = len(_RE_OBJECT3D_NEW.findall(code))
    n_names = len(_RE_NAME_ASSIGN.findall(code))
    # naming violation: created nodes left unnamed, OR any generic name used.
    naming = (n_objects > n_names) or bool(_RE_GENERIC_NAME.search(code))

    return {
        "sandbox": bool(_RE_SANDBOX.search(code)),
        "forbidden_api": bool(_RE_FORBIDDEN_API.search(code)),
        "image_texture": bool(_RE_IMAGE_TEXTURE.search(code)),
        "naming": naming,
    }


# Maps each ablation condition to the violation category its removed rule targets.
# C0 is the baseline; C4 (invented methods) has no static detector — its effect
# is read from the runtime reference_error/type_error proxy instead.
_VIOLATION_CATEGORIES = ["sandbox", "forbidden_api", "image_texture", "naming"]
_CONDITION_TARGET_VIOLATION: dict[str, str | None] = {
    "C0": None,
    "C1": "sandbox",
    "C2": "forbidden_api",
    "C3": "naming",
    "C4": None,
    "C5": None,  # removes all rules — not a single-target condition
}
_VIOLATION_LABELS = {
    "sandbox": "imports / DOM access",
    "forbidden_api": "loaders / OrbitControls / URLs",
    "image_texture": "image-based textures",
    "naming": "missing / generic node names",
}


# Human-readable labels for conditions
_CONDITION_LABELS = {
    "C0": "Full prompt (baseline)",
    "C1": "w/o Sandbox context (rules 1-2: NO IMPORTS, NO DOM)",
    "C2": "w/o Forbidden APIs (rules 3-4: NO ASSETS, NO CONTROLS)",
    "C3": "w/o Procedural craft (rules 5-6: TEXTURES, SEMANTIC NAMES)",
    "C4": "w/o Hallucination guard (rule 7: NO INVENTED METHODS)",
    "C5": "No constraints (full ablation)",
}


# ---------------------------------------------------------------------------
# Statistical significance (Fisher exact test, pure Python — no scipy)
# ---------------------------------------------------------------------------


def _fisher_two_tailed(a: int, b: int, c: int, d: int) -> float:
    """Two-tailed Fisher exact p-value for the 2x2 table [[a, b], [c, d]]."""
    n = a + b + c + d
    row1, col1 = a + b, a + c

    def p_hyper(x: int) -> float:
        return comb(col1, x) * comb(n - col1, row1 - x) / comb(n, row1)

    p_obs = p_hyper(a)
    lo, hi = max(0, row1 - (n - col1)), min(row1, col1)
    return sum(p_hyper(x) for x in range(lo, hi + 1) if p_hyper(x) <= p_obs * 1.000001)


def _significance_vs_baseline(
    stats: dict[str, dict], baseline: str = "C0"
) -> dict[str, float | None]:
    """p-value of each condition's first-pass error count vs the baseline (None for baseline)."""
    if baseline not in stats:
        return {}
    e0, n0 = stats[baseline]["first_pass_error_count"], stats[baseline]["n"]
    out: dict[str, float | None] = {}
    for cond, s in stats.items():
        if cond == baseline:
            out[cond] = None
            continue
        ec, nc = s["first_pass_error_count"], s["n"]
        out[cond] = _fisher_two_tailed(ec, nc - ec, e0, n0 - e0)
    return out


def _significance_violation_vs_baseline(
    stats: dict[str, dict], baseline: str = "C0"
) -> dict[str, float | None]:
    """p-value of each condition's *target* violation count vs the baseline's
    count for the same category. None when the condition has no target category."""
    if baseline not in stats:
        return {}
    b = stats[baseline]
    out: dict[str, float | None] = {}
    for cond, s in stats.items():
        cat = _CONDITION_TARGET_VIOLATION.get(cond)
        if cat is None or s.get("code_count", 0) == 0 or b.get("code_count", 0) == 0:
            out[cond] = None
            continue
        vc, nc = s["violation_counts"].get(cat, 0), s["code_count"]
        v0, n0 = b["violation_counts"].get(cat, 0), b["code_count"]
        out[cond] = _fisher_two_tailed(vc, nc - vc, v0, n0 - v0)
    return out


def _sig(p: float | None) -> str:
    """Format a p-value with a significance marker for the report."""
    if p is None:
        return "—"
    mark = "***" if p < 0.01 else "**" if p < 0.05 else "*" if p < 0.1 else "ns"
    return f"{p:.3f} ({mark})"


# ---------------------------------------------------------------------------
# Statistical power analysis (simulation-based, no external dependencies)
# ---------------------------------------------------------------------------

_POWER_CURVE_NS = [25, 50, 75, 100, 150, 200, 300, 500]


def _simulate_power(
    p0: float, p1: float, n: int,
    n_sim: int = 5000, alpha: float = 0.05, seed: int = 42,
) -> float:
    """Simulate two-proportions Fisher test power at a given N per group.

    p0 = C0 error rate (lower), p1 = C5 error rate (higher).
    Returns the fraction of simulations where Fisher p < alpha.
    Uses only stdlib random — no numpy/scipy dependency.
    """
    from random import Random
    rng = Random(seed)
    hits = 0
    for _ in range(n_sim):
        a = sum(1 for _ in range(n) if rng.random() < p1)   # C5 errors
        c = sum(1 for _ in range(n) if rng.random() < p0)   # C0 errors
        p = _fisher_two_tailed(a, n - a, c, n - c)
        if p < alpha:
            hits += 1
    return hits / n_sim


def _power_curve(p0: float, p1: float) -> list[tuple[int, float]]:
    """Return [(n, power), ...] for each candidate N in _POWER_CURVE_NS."""
    return [(n, _simulate_power(p0, p1, n)) for n in _POWER_CURVE_NS]


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

        # Constraint-violation counts on the first-pass (v1) generated code.
        # code_count tracks how many records actually carry code, so old JSONL
        # (no "code" field) can be reported as n/a rather than 0%.
        violation_counts: dict[str, int] = defaultdict(int)
        code_count = 0
        for r in items:
            arts = r.get("artifacts") or []
            code = arts[0].get("code") if arts else None
            if not code:
                continue
            code_count += 1
            for cat, hit in detect_violations(code).items():
                if hit:
                    violation_counts[cat] += 1

        # Runnable = models whose final artifact has no execution error.
        # Approval rate is computed over runnable models (decoupled from Error),
        # so a low error count doesn't inflate the quality proxy.
        runnable = n - final_errors
        results[condition] = {
            "n": n,
            "first_pass_error_rate": first_pass_errors / n if n else 0,
            "final_error_rate": final_errors / n if n else 0,
            "avg_revisions": round(avg_revisions, 3),
            "avg_elapsed_s": round(avg_elapsed, 1),
            "approval_rate": round(approved_count / runnable, 3) if runnable else 0,
            "approved_count": approved_count,
            "runnable_count": runnable,
            "first_pass_error_count": first_pass_errors,
            "final_error_count": final_errors,
            "first_pass_error_types": dict(first_type_counts),
            "violation_counts": dict(violation_counts),
            "code_count": code_count,
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


def write_csv(stats: dict[str, dict], sig: dict[str, float | None], path: Path) -> None:
    fieldnames = [
        "condition", "label", "n",
        "first_pass_error_rate", "final_error_rate", "sig_p_vs_c0",
        "avg_revisions", "avg_elapsed_s",
        "approval_rate", "approved_count", "runnable_count",
        "code_count",
    ] + [f"first_err_{t}" for t in _ALL_ERROR_TYPES] \
      + [f"violation_{c}" for c in _VIOLATION_CATEGORIES]

    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for condition in _ALL_CONDITIONS:
            if condition not in stats:
                continue
            s = stats[condition]
            p = sig.get(condition)
            row = {
                "condition": condition,
                "label": _CONDITION_LABELS.get(condition, condition),
                "n": s["n"],
                "first_pass_error_rate": f"{s['first_pass_error_rate']:.3f}",
                "final_error_rate": f"{s['final_error_rate']:.3f}",
                "sig_p_vs_c0": "" if p is None else f"{p:.4f}",
                "avg_revisions": f"{s['avg_revisions']:.3f}",
                "avg_elapsed_s": f"{s['avg_elapsed_s']:.1f}",
                "approval_rate": f"{s['approval_rate']:.3f}",
                "approved_count": s["approved_count"],
                "runnable_count": s["runnable_count"],
            }
            etypes = s.get("first_pass_error_types") or {}
            for t in _ALL_ERROR_TYPES:
                row[f"first_err_{t}"] = etypes.get(t, 0)
            row["code_count"] = s.get("code_count", 0)
            vcounts = s.get("violation_counts") or {}
            for c in _VIOLATION_CATEGORIES:
                row[f"violation_{c}"] = vcounts.get(c, 0)
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
    sig: dict[str, float | None],
    path: Path,
    input_paths: list[Path],
    records: list[dict] | None = None,
) -> None:
    def _fmt(etypes: dict, n: int, t: str) -> str:
        count = etypes.get(t, 0)
        pct = count / n * 100 if n else 0
        return f"{count} ({pct:.0f}%)"

    ts = datetime.now(tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        "# Ablation Study Results",
        "",
        f"Generated: {ts}  ",
        f"Input files: {', '.join(p.name for p in input_paths)}",
        "",
        "## Experiment Configuration",
        "",
    ]

    # Deduce experiment parameters from records
    if records:
        conditions = sorted(set(r["condition"] for r in records))
        repeats = max((r.get("repeat", 0) for r in records), default=0) + 1
        per_condition = stats.get(conditions[0], {}).get("n", "?") if conditions else "?"
        cfg = records[0].get("config", {})

        lines += [
            f"**Conditions** (ablation targets, each N={per_condition}):  ",
        ]
        for cond in conditions:
            label = _CONDITION_LABELS.get(cond, cond)
            lines.append(f"- {cond}: {label}")

        # Show config if available; fallback to graceful defaults if missing
        lines.append("")
        if cfg.get("model"):
            lines.append(f"**Model**: {cfg.get('model')}")
        if cfg.get("template"):
            lines.append(f"**Template**: {cfg.get('template')}")
        if cfg.get("max_reviews") is not None:
            lines.append(f"**Max reviews**: {cfg.get('max_reviews')}")
        if cfg.get("batch_size") is not None:
            lines.append(f"**Batch size**: {cfg.get('batch_size')}")
        if cfg.get("timeout_ms") is not None:
            lines.append(f"**Timeout**: {cfg.get('timeout_ms')} ms")
        if cfg.get("skip_review"):
            lines.append("**Review**: disabled")

        lines += [
            f"**Repeats**: {repeats}  ",
            f"**Total samples**: {len(records)}  ",
            "",
        ]

    # Constraint Adherence — headline table. For each ablated condition, the
    # violation rate of the rule group it removed, head-to-head against C0.
    baseline_codes = stats.get("C0", {}).get("code_count", 0)
    vsig = _significance_violation_vs_baseline(stats)
    if baseline_codes:
        b = stats["C0"]
        lines += [
            "## Constraint Adherence (primary)",
            "",
            "| Condition | Removed rule (target) | Violation@C0 | Violation@removed | Δ | Sig. |",
            "|---|---|---|---|---|---|",
        ]
        for condition in _ALL_CONDITIONS:
            cat = _CONDITION_TARGET_VIOLATION.get(condition)
            if condition not in stats or cat is None:
                continue
            s = stats[condition]
            nc = s.get("code_count", 0)
            if not nc:
                continue
            vc = s["violation_counts"].get(cat, 0)
            v0 = b["violation_counts"].get(cat, 0)
            r0 = v0 / baseline_codes
            rc = vc / nc
            lines.append(
                f"| **{condition}** | {_VIOLATION_LABELS.get(cat, cat)} "
                f"| {_pct(r0)} ({v0}/{baseline_codes}) "
                f"| {_pct(rc)} ({vc}/{nc}) "
                f"| {(rc - r0) * 100:+.1f}pp "
                f"| {_sig(vsig.get(condition))} |"
            )
        lines += [
            "",
            "> **Violation**: % of first-pass generated code statically containing the construct the removed rule forbids.  ",
            "> Measured on code (not execution), so it captures violations that never crash (e.g. generic node names, ignored DOM access).  ",
            "> **C4** (NO INVENTED METHODS) has no static detector; read its effect from `reference_error`/`type_error` in the Error Type Breakdown.  ",
            "> **Sig.**: two-tailed Fisher exact p-value of the target violation count vs C0.",
            "",
        ]

    # Build main results table header dynamically based on skip_review
    skip_review = cfg.get("skip_review", False)
    if skip_review:
        lines += [
            "## Main Results",
            "",
            "| Condition | Description | N | Error ↓ | Avg Time (s) | Sig. (p vs C0) |",
            "|---|---|---|---|---|---|",
        ]
    else:
        lines += [
            "## Main Results",
            "",
            "| Condition | Description | N | Error ↓ | Avg Time (s) | Approval ↑ | Sig. (p vs C0) |",
            "|---|---|---|---|---|---|---|",
        ]

    for condition in _ALL_CONDITIONS:
        if condition not in stats:
            continue
        s = stats[condition]
        label = _CONDITION_LABELS.get(condition, condition)
        error_str = f"{_pct(s['first_pass_error_rate'])} ({s['first_pass_error_count']}/{s['n']})"

        if skip_review:
            lines.append(
                f"| **{condition}** | {label} | {s['n']} "
                f"| {error_str} "
                f"| {s['avg_elapsed_s']:.1f} "
                f"| {_sig(sig.get(condition))} |"
            )
        else:
            approval = (
                f"{_pct(s['approval_rate'])} ({s['approved_count']}/{s['runnable_count']})"
            )
            lines.append(
                f"| **{condition}** | {label} | {s['n']} "
                f"| {error_str} "
                f"| {s['avg_elapsed_s']:.1f} "
                f"| {approval} "
                f"| {_sig(sig.get(condition))} |"
            )

    lines += [
        "",
        "> **Error**: % of runs whose generated code had execution errors.  ",
        "> **Approval**: % approved by the LLM visual reviewer among *runnable* models — `(approved/runnable)`. Denominator excludes errored runs, so it is decoupled from Error.  ",
        "> **Sig.**: two-tailed Fisher exact p-value of Error vs C0 baseline.  ",
        "> Significance marks: `***` p<0.01 | `**` p<0.05 | `*` p<0.1 | `ns` not significant (p≥0.1).",
        "",
        "## Error Type Breakdown",
        "",
        "| Condition | " + " | ".join(_ALL_ERROR_TYPES) + " |",
        "|---|" + "---|" * len(_ALL_ERROR_TYPES),
    ]

    for condition in _ALL_CONDITIONS:
        if condition not in stats:
            continue
        etypes = stats[condition].get("first_pass_error_types") or {}
        n = stats[condition]["n"]
        lines.append(
            f"| **{condition}** | "
            + " | ".join(_fmt(etypes, n, t) for t in _ALL_ERROR_TYPES)
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
                "| Condition | N | Error |",
                "|---|---|---|",
            ]
            for condition in _ALL_CONDITIONS:
                d = diff_stats.get(condition, {}).get(difficulty)
                if d is None:
                    continue
                lines.append(
                    f"| **{condition}** | {d['n']} "
                    f"| {_pct(d['first_pass_error_rate'])} |"
                )
            lines.append("")

    # Power Analysis — only when both C0 and C5 are present in the dataset.
    if "C0" in stats and "C5" in stats:
        s0 = stats["C0"]
        s5 = stats["C5"]
        p0 = s0["first_pass_error_rate"]
        p5 = s5["first_pass_error_rate"]
        n_current = s0["n"]

        log.info("Computing power curve for C0(%.1f%%) vs C5(%.1f%%) ...", p0 * 100, p5 * 100)
        curve = _power_curve(p0, p5)

        min_n_80 = next((n for n, pw in curve if pw >= 0.80), None)
        repeats_per_50 = f"{min_n_80 // 50} repeats" if min_n_80 else "500+ samples"

        lines += [
            "",
            "## Power Analysis: C0 vs C5",
            "",
            f"Observed error rates — C0: **{_pct(p0)}** ({s0['first_pass_error_count']}/{s0['n']}), "
            f"C5: **{_pct(p5)}** ({s5['first_pass_error_count']}/{s5['n']})",
            "",
            "| N / condition | Simulated power (α=0.05, two-tailed Fisher) |",
            "|---|---|",
        ]
        for n, pw in curve:
            marker = " ← **current run**" if n == n_current else ""
            bold = "**" if n == n_current else ""
            lines.append(f"| {bold}{n}{bold} | {bold}{pw * 100:.1f}%{bold}{marker} |")

        lines += [
            "",
            f"> Simulation: 5,000 draws per cell, fixed seed=42.  ",
            f"> **80% power requires N ≥ {min_n_80 if min_n_80 else '500+'} per condition "
            f"(= {repeats_per_50} with the 50-prompt dataset).**",
        ]

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
    sig = _significance_vs_baseline(stats)

    # Print summary to console
    print("\n=== Ablation Study Summary ===\n")
    print(f"{'Condition':<6}  {'Description':<38}  {'N':>4}  {'Error':>7}  {'Time':>7}  {'Sig(p vs C0)':>14}")
    print("-" * 86)
    for condition in _ALL_CONDITIONS:
        if condition not in stats:
            continue
        s = stats[condition]
        print(
            f"{condition:<6}  {_CONDITION_LABELS.get(condition, ''):<38}  "
            f"{s['n']:>4}  {_pct(s['first_pass_error_rate']):>7}  "
            f"{s['avg_elapsed_s']:>6.1f}s  {_sig(sig.get(condition)):>14}"
        )
    print()

    # Write outputs — use the timestamp from the input filename(s) for traceability
    # e.g. raw_20260619T093816Z.jsonl → summary_20260619T093816Z.csv
    ts_candidates = [re.search(r"\d{8}T\d{6}Z", p.name) for p in input_paths]
    ts_matches = [m.group() for m in ts_candidates if m]
    ts = min(ts_matches) if ts_matches else datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    _RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    write_csv(stats, sig, _RESULTS_DIR / f"summary_{ts}.csv")
    write_markdown(stats, diff_stats, sig, _RESULTS_DIR / f"summary_{ts}.md", input_paths, records)

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
