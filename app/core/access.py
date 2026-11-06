"""Who is an admin / approver. Admins = bootstrap (PLATFORM_ADMINS: the deployer, set by the bundle) + admins granted
in the app (Lakebase app_admin). Approver scopes come from the approver table; admins approve everything.

Resolved per request through a short TTL cache that every write invalidates, so a grant works on the next click.
When the store is down, bootstrap admins still work (never locked out) and grants fail loudly (503).
"""
from __future__ import annotations

import threading
import time
from typing import Any

from core import config, repo
from core.lakebase import Lakebase

TTL = 10.0
_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()


def invalidate() -> None:
    with _lock:
        _cache.clear()


def _cached(key: str, fn):
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < TTL:
            return hit[1]
    val = fn()
    with _lock:
        _cache[key] = (now, val)
    return val


def bootstrap_admins() -> list[str]:
    return list(dict.fromkeys(config.PLATFORM_ADMINS))


def granted(lb: Lakebase) -> list[dict[str, Any]]:
    try:
        return _cached("admins", lambda: repo.granted_admins(lb))
    except Exception:  # noqa: BLE001 - store down: bootstrap admins only
        return []


def is_admin(lb: Lakebase, email: str) -> bool:
    e = email.lower()
    return e in bootstrap_admins() or any(a["email"] == e for a in granted(lb))


def approver_scopes(lb: Lakebase, email: str) -> list[str]:
    e = email.lower()
    try:
        rows = _cached("approvers", lambda: repo.approvers(lb))
    except Exception:  # noqa: BLE001
        rows = []
    scopes = [r["scope"] for r in rows if r["email"] == e]
    if is_admin(lb, e):
        scopes.append("domain:*")
    return sorted(set(scopes))
