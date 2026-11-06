"""Who is calling. On Databricks Apps the proxy injects X-Forwarded-Email / -Preferred-Username / -Access-Token."""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request

from core import config


@dataclass(frozen=True)
class Caller:
    email: str
    name: str
    token: str | None = None  # the user's OBO token (user authorization); never logged


def caller(request: Request) -> Caller:
    h = request.headers
    if config.IDENTITY_MODE == "fixed" and config.DEV_USER:
        email = config.DEV_USER
    else:
        email = (h.get("x-forwarded-email") or h.get("x-forwarded-preferred-username") or "").strip()
        if not email and config.IDENTITY_MODE in ("header", "fixed"):
            email = config.DEV_USER
    email = email.lower() or "anonymous@local"
    name = (h.get("x-forwarded-preferred-username") or email.split("@")[0]).replace(".", " ").title()
    return Caller(email=email, name=name, token=h.get("x-forwarded-access-token"))
