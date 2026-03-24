import sys
import importlib
from pathlib import Path

_src = str(Path(__file__).parent / "src")
# Ensure src is first so agents_server resolves to src/agents_server,
# not to the empty __init__.py in the project root.
if _src not in sys.path:
    sys.path.insert(0, _src)

# If agents_server was already imported from the wrong location, evict it.
if "agents_server" in sys.modules:
    wrong = sys.modules["agents_server"].__file__ or ""
    if "src" not in wrong:
        for key in list(sys.modules):
            if key == "agents_server" or key.startswith("agents_server."):
                del sys.modules[key]
