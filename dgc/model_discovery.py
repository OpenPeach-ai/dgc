"""Shared model-catalog checks for editor and Pip model choices."""

from __future__ import annotations

import re


_EMBEDDING_NAME = re.compile(
    r"(?:^|[/_.:-])(?:embed(?:ding|dings)?|rerank|bge|gte|minilm|e5)(?:$|[/_.:-])",
    re.I,
)


def embedding_only(model: str, family: str = "") -> bool:
    """Exclude known embedding/rerank models from chat choices, including Ollama aliases."""
    family = family.lower()
    return bool(_EMBEDDING_NAME.search(model) or _EMBEDDING_NAME.search(family)
                or family in {"bert", "nomic-bert"})
