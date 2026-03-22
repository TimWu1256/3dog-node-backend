import re


def extract_code_from_markdown(markdown: str) -> str | None:
    """Port of the TS extractCodeFromMarkdown – pull the first fenced code block."""
    # Fast path: complete fenced block
    match = re.search(r"```(?:[^\n]*)\n([\s\S]*?)```\n?", markdown)
    if match:
        return match.group(1)

    # Fallback: opening fence without closing fence
    start = markdown.find("```")
    if start == -1:
        return None
    first_newline = markdown.find("\n", start)
    if first_newline == -1:
        return None
    code_start = first_newline + 1
    end = markdown.find("```", code_start)
    if end != -1:
        return markdown[code_start:end]
    return markdown[code_start:]


def stringify_error(exc: Exception) -> str:
    return f"{type(exc).__name__}: {exc}"
