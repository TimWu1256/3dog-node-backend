"""
Jinja2-based instruction template loader.

Templates live in  <repo-root>/instructions/
The path is resolved relative to this file:  agents/src/common/ → ../../../instructions/

Override with the env var  INSTRUCTIONS_DIR  if needed.
"""

import os
from pathlib import Path
from typing import Callable

from jinja2 import Environment, FileSystemLoader, StrictUndefined

_DEFAULT_INSTRUCTIONS_DIR = (
    Path(__file__).resolve().parents[3] / "instructions"
)

def _get_env() -> Environment:
    instructions_dir = Path(os.environ.get("INSTRUCTIONS_DIR", _DEFAULT_INSTRUCTIONS_DIR))
    return Environment(
        loader=FileSystemLoader(str(instructions_dir)),
        undefined=StrictUndefined,
        keep_trailing_newline=True,
    )


def load_instructions_template(name: str) -> Callable[[dict], str]:
    """
    Load  instructions/<name>.md  as a Jinja2 template.
    Returns a callable  render(context: dict) -> str.
    """
    env = _get_env()
    template = env.get_template(f"{name}.md")
    return template.render
