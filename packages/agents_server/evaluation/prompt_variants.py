"""
Ablation prompt variant generator.

Reads craft3d-generation-v3.md and produces modified versions that remove one
rule group at a time from STRICT CONSTRAINTS, keeping all other sections fixed
(ENV CONTEXT, CODE STRUCTURE, ENSURE, AESTHETIC GUIDELINES, ROLE, INPUT).

The 7 STRICT CONSTRAINTS rules are grouped by semantic function:
  Group A — Sandbox context    (rules 1-2): NO IMPORTS, NO DOM ACCESS
  Group B — Forbidden APIs     (rules 3-4): NO EXTERNAL ASSETS, NO CONTROLS
  Group C — Procedural craft   (rules 5-6): TEXTURES, SEMANTIC NODE NAMES
  Group D — Hallucination guard (rule 7):  NO INVENTED METHODS

Conditions:
  C0: Full prompt (baseline, no changes)
  C1: w/o Group A — Sandbox context (rules 1-2)
  C2: w/o Group B — Forbidden APIs (rules 3-4)
  C3: w/o Group C — Procedural craft (rules 5-6)
  C4: w/o Group D — Hallucination guard (rule 7)
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from jinja2 import Environment, StrictUndefined

# Section markers
_STRICT_CONSTRAINTS = "**STRICT CONSTRAINTS (VIOLATIONS CAUSE CRASHES):**"
_AESTHETIC_GUIDELINES = "**AESTHETIC GUIDELINES:**"
_ENVIRONMENT_CONTEXT = "**ENVIRONMENT CONTEXT:**"
_CODE_STRUCTURE = "**CODE STRUCTURE:**"
_ROLE = "**ROLE:**"
_INPUT_PARAMETERS = "**INPUT PARAMETERS:**"
_ENSURE_LINE = "**ENSURE THE CODE IS VALID JAVASCRIPT"

# Rule-line markers (line prefixes within STRICT CONSTRAINTS)
_RULE_1 = "1. **NO IMPORTS"
_RULE_3 = "3. **NO EXTERNAL ASSETS"
_RULE_5 = "5. **TEXTURES"
_RULE_7 = "7. **NO INVENTED METHODS"

# Path to the v3 generation template
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
        return _remove_rules(raw, _RULE_1, _RULE_3)
    if condition == "C2":
        return _remove_rules(raw, _RULE_3, _RULE_5)
    if condition == "C3":
        return _remove_rules(raw, _RULE_5, _RULE_7)
    if condition == "C4":
        return _remove_rule7(raw)
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


def _remove_rules(raw: str, start_marker: str, end_marker: str) -> str:
    """Remove consecutive STRICT CONSTRAINTS rules from start_marker up to (not including) end_marker."""
    ls = _split(raw)
    start = _find(ls, start_marker)
    end = _find(ls, end_marker)
    return "".join(ls[:start] + ls[end:])


def _remove_rule7(raw: str) -> str:
    """C4: Remove rule 7 (NO INVENTED METHODS) and its indented sub-bullets."""
    ls = _split(raw)
    start = _find(ls, _RULE_7)
    end = start + 1
    while end < len(ls):
        stripped = ls[end].strip()
        if stripped.startswith(">") or (stripped and ls[end][0] in " \t"):
            end += 1
        else:
            break
    return "".join(ls[:start] + ls[end:])
