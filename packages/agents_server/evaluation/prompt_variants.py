"""
Ablation prompt variant generator.

Reads craft3d-generation-v3.md and produces modified versions by removing
specific error-prevention sections, while keeping aesthetic guidelines intact.

Conditions:
  C0: Full prompt (baseline, no changes)
  C1: w/o STRICT CONSTRAINTS block (all 7 rules removed)
  C2: w/o NO INVENTED METHODS only (rule #7 removed)
  C3: w/o ENVIRONMENT CONTEXT + CODE STRUCTURE scaffold
  C4: Minimal prompt (ROLE + INPUT PARAMETERS + final ENSURE line only)
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from jinja2 import Environment, StrictUndefined

# Section markers used to locate paragraph boundaries
_STRICT_CONSTRAINTS = "**STRICT CONSTRAINTS (VIOLATIONS CAUSE CRASHES):**"
_AESTHETIC_GUIDELINES = "**AESTHETIC GUIDELINES:**"
_INVENTED_METHODS = "7. **NO INVENTED METHODS**"
_ENVIRONMENT_CONTEXT = "**ENVIRONMENT CONTEXT:**"
_CODE_STRUCTURE = "**CODE STRUCTURE:**"
_ROLE = "**ROLE:**"
_INPUT_PARAMETERS = "**INPUT PARAMETERS:**"
_ENSURE_LINE = "**ENSURE THE CODE IS VALID JAVASCRIPT"

# Path to the v3 generation template (2 levels up from this file → repo root → instructions/)
_V3_TEMPLATE_PATH = Path(__file__).resolve().parents[3] / "instructions" / "craft3d-generation-v3.md"


def make_variant(condition: str, template_path: Path = _V3_TEMPLATE_PATH) -> Callable[[dict], str]:
    """Return a Jinja2 render(context: dict) -> str callable for the given ablation condition.

    Drop-in replacement for load_instructions_template() return value, safe to monkeypatch
    nodes_module._render_generation_prompt.
    """
    raw = template_path.read_text(encoding="utf-8")
    modified = _apply_condition(raw, condition)
    env = Environment(undefined=StrictUndefined, keep_trailing_newline=True)
    return env.from_string(modified).render


def _apply_condition(raw: str, condition: str) -> str:
    if condition == "C0":
        return raw
    if condition == "C1":
        return _remove_strict_constraints(raw)
    if condition == "C2":
        return _remove_invented_methods(raw)
    if condition == "C3":
        return _remove_environment_and_code_structure(raw)
    if condition == "C4":
        return _minimal_prompt(raw)
    raise ValueError(f"Unknown ablation condition: {condition!r}. Valid: C0, C1, C2, C3, C4")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _split(raw: str) -> list[str]:
    return raw.splitlines(keepends=True)


def _find(lines: list[str], marker: str) -> int:
    """Return 0-based index of the first line containing marker. Raises if absent."""
    for i, line in enumerate(lines):
        if marker in line:
            return i
    raise ValueError(f"Section marker not found in template: {marker!r}")


def _remove_strict_constraints(raw: str) -> str:
    """C1: Remove the entire STRICT CONSTRAINTS block (lines 12-22 in v3.md)."""
    ls = _split(raw)
    start = _find(ls, _STRICT_CONSTRAINTS)
    end = _find(ls, _AESTHETIC_GUIDELINES)
    # Pull start back to consume the blank separator line before the block
    if start > 0 and ls[start - 1].strip() == "":
        start -= 1
    # Preserve the blank line immediately before AESTHETIC GUIDELINES as a section separator
    return "".join(ls[:start] + ls[end - 1:])


def _remove_invented_methods(raw: str) -> str:
    """C2: Remove only rule #7 (NO INVENTED METHODS) and its indented sub-bullets."""
    ls = _split(raw)
    start = _find(ls, _INVENTED_METHODS)
    end = start + 1
    # Consume sub-bullet lines: those that are indented (start with whitespace) or begin with ">"
    while end < len(ls):
        stripped = ls[end].strip()
        if stripped.startswith(">") or (stripped and ls[end][0] in " \t"):
            end += 1
        else:
            break
    return "".join(ls[:start] + ls[end:])


def _remove_environment_and_code_structure(raw: str) -> str:
    """C3: Remove ENVIRONMENT CONTEXT section and CODE STRUCTURE section (to EOF).

    This removes the scaffold that tells the LLM about pre-injected globals (THREE,
    GLTFExporter, __export) and the required code structure, while keeping STRICT
    CONSTRAINTS and AESTHETIC GUIDELINES intact.
    """
    ls = _split(raw)

    # Step 1 — remove ENVIRONMENT CONTEXT block
    env_start = _find(ls, _ENVIRONMENT_CONTEXT)
    strict_start = _find(ls, _STRICT_CONSTRAINTS)
    # Pull env_start back to consume the preceding blank separator line
    if env_start > 0 and ls[env_start - 1].strip() == "":
        env_start -= 1
    # Keep the blank line just before STRICT CONSTRAINTS as separator after ROLE
    ls = ls[:env_start] + ls[strict_start - 1:]

    # Step 2 — remove CODE STRUCTURE to EOF (indices shifted after step 1)
    code_start = _find(ls, _CODE_STRUCTURE)
    # Consume the blank line before CODE STRUCTURE
    if code_start > 0 and ls[code_start - 1].strip() == "":
        code_start -= 1
    ls = ls[:code_start]

    return "".join(ls)


def _minimal_prompt(raw: str) -> str:
    """C4: Minimal prompt — ROLE + INPUT PARAMETERS + final ENSURE constraint line."""
    ls = _split(raw)

    env_start = _find(ls, _ENVIRONMENT_CONTEXT)
    code_start = _find(ls, _CODE_STRUCTURE)
    role_start = _find(ls, _ROLE)
    input_start = _find(ls, _INPUT_PARAMETERS)
    ensure_idx = _find(ls, _ENSURE_LINE)

    title = ls[:1]  # "# SYSTEM PROMPT\n"
    role_block = ls[role_start - 1: env_start - 1]    # blank + ROLE paragraph
    input_block = ls[input_start - 1: code_start - 1]  # blank + INPUT PARAMETERS block
    ensure_line = ls[ensure_idx:]

    return "".join(title + role_block + input_block + ["\n"] + ensure_line)
