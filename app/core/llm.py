"""Chat completions through a Databricks serving endpoint (Foundation Model API). No `temperature`: Claude 5
endpoints reject it. Callers must handle LLMUnavailable (the assistant falls back to its rules parser)."""
from __future__ import annotations

import json
import re
from typing import Any

from core import config
from core.errors import Unavailable
from core.lakebase import workspace_client


class LLMUnavailable(Unavailable):
    pass


def chat(messages: list[dict[str, str]], max_tokens: int = 900) -> str:
    if config.OFFLINE or not config.LLM_ENDPOINT:
        raise LLMUnavailable("no LLM endpoint configured")
    try:
        r = workspace_client().api_client.do("POST", f"/serving-endpoints/{config.LLM_ENDPOINT}/invocations",
                                             body={"messages": messages, "max_tokens": max_tokens})
    except Exception as e:  # noqa: BLE001
        raise LLMUnavailable(f"{type(e).__name__}: {str(e)[:200]}") from e
    choices = (r or {}).get("choices") or []
    content = (choices[0].get("message") or {}).get("content") if choices else None
    if isinstance(content, list):  # content blocks
        content = "".join(b.get("text", "") for b in content if isinstance(b, dict))
    if not content:
        raise LLMUnavailable("empty completion")
    return str(content)


def first_json(text: str) -> dict[str, Any]:
    """The first JSON object in a completion (models sometimes wrap it in prose or a code fence)."""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("no JSON object in the completion")
    return json.loads(m.group(0))
