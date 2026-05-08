"""Provider-aware LLM router.

Model strings use the format ``<provider>/<model-name>``:
    ``openai/gpt-5.4``
    ``google/gemini-3-flash-preview``

Bare names (no slash) are accepted: ``gemini*`` → google, otherwise → openai.
"""

from __future__ import annotations

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI


def get_chat_model(
    model_str: str,
    *,
    openai_kwargs: dict | None = None,
    google_kwargs: dict | None = None,
) -> BaseChatModel:
    """Instantiate the correct LangChain model for *model_str*.

    Pass provider-specific constructor kwargs via *openai_kwargs* / *google_kwargs*;
    only the matching dict is forwarded, so callers can supply both without conflict.
    """
    provider, model_name = parse_model_str(model_str)
    if provider == "google":
        return ChatGoogleGenerativeAI(model=model_name, **(google_kwargs or {}))
    if provider == "openai":
        return ChatOpenAI(model=model_name, **(openai_kwargs or {}))
    raise ValueError(f"Unknown provider '{provider}' in model string '{model_str}'")


def parse_model_str(model_str: str) -> tuple[str, str]:
    """Return ``(provider, model_name)`` from a model string.

    Accepts ``provider/model-name`` or a bare model name.
    """
    if "/" in model_str:
        provider, model_name = model_str.split("/", 1)
        return provider.lower(), model_name
    provider = "google" if model_str.startswith("gemini") else "openai"
    return provider, model_str


def normalize(model_str: str) -> str:
    """Return the canonical ``provider/model-name`` form."""
    provider, model_name = parse_model_str(model_str)
    return f"{provider}/{model_name}"
