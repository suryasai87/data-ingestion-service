"""Tiered reads: Lakebase -> Lakehouse (warehouse) -> built-in. A read endpoint never answers 500.

Each tier is a zero-argument callable; the first that returns without raising wins. The answer says which tier
served it (`source`) and why the better tiers did not (`degraded_reason`), so the UI can show the source pill.
"""
from __future__ import annotations

import logging
from typing import Any, Callable

log = logging.getLogger("dis.tiers")


def read(*tiers: tuple[str, Callable[[], Any] | None]) -> tuple[Any, str, str | None]:
    reasons: list[str] = []
    for name, fn in tiers:
        if fn is None:
            continue
        try:
            return fn(), name, ("; ".join(reasons) or None)
        except Exception as e:  # noqa: BLE001 - a failing tier degrades, it never breaks the page
            reasons.append(f"{name}: {type(e).__name__}: {' '.join(str(e).split())[:160]}")
            log.info("tier %s failed: %s", name, reasons[-1])
    raise RuntimeError("no tier answered: " + "; ".join(reasons))


def sourced(data: dict[str, Any], source: str, reason: str | None) -> dict[str, Any]:
    return {**data, "source": source, "degraded_reason": reason}
