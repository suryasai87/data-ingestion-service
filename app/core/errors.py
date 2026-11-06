"""Error classes that map 1:1 to HTTP answers (app.py registers the handlers).

Order for governed writes: 400 (bad input) -> 503 (store down / kiosk) -> 403 (not allowed) -> 409 (wrong state).
"""
from __future__ import annotations


class BadRequest(ValueError):
    status = 400


class Unavailable(RuntimeError):
    status = 503


class Forbidden(PermissionError):
    status = 403


class Conflict(RuntimeError):
    status = 409


class NotFound(LookupError):
    status = 404
