"""21 CFR Part 11 electronic signatures.

- §11.200(a): two distinct identification components. Component 1 = the signer's Databricks SSO identity (the
  forwarded, already-authenticated user); component 2 = a signing PIN only the signer knows. The PIN is stored as an
  scrypt hash (never logged, never returned); 3 wrong PINs lock signing for 15 minutes; an admin can reset a PIN
  (audited) but can never see or set it.
- §11.50: every signature shows the printed name, the date and time (UTC) and the meaning (Approved, Released to ...).
- §11.70: the signature is bound to the record: request id + version + the configuration's SHA-256 content hash, and
  sealed with a manifest hash so a later edit of the record or the signature row is detectable.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from core import lakebase, repo
from core.errors import BadRequest, Conflict, Forbidden
from core.identity import Caller

MEANINGS = ("Approved", "Rejected", "Released to UAT", "Released to Production", "Reviewed")
MAX_FAILED = 3
LOCK_MINUTES = 15
_N, _R, _P = 2 ** 14, 8, 1
PIN_RX = re.compile(r"^\d{6,12}$")


def hash_pin(pin: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    h = hashlib.scrypt(pin.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=32)
    return f"scrypt${_N}${_R}${_P}${base64.b64encode(salt).decode()}${base64.b64encode(h).decode()}"


def check_pin(pin: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, h = stored.split("$")
        got = hashlib.scrypt(pin.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=32)
        return hmac.compare_digest(got, base64.b64decode(h))
    except (ValueError, TypeError):
        return False


def manifest_hash(signer: str, meaning: str, signed_at: str, rid: str, version: int, config_hash: str) -> str:
    return hashlib.sha256(f"{signer}|{meaning}|{signed_at}|{rid}|{version}|{config_hash}".encode()).hexdigest()


def pin_status(caller: Caller) -> dict[str, Any]:
    r = lakebase.get().query(f"SELECT set_at, locked_until FROM {repo.S()}.signing_pin WHERE email = %s", (caller.email,))
    if not r:
        return {"has_pin": False, "set_at": None, "locked_until": None}
    return {"has_pin": True, "set_at": repo.iso(r[0]["set_at"]), "locked_until": repo.iso(r[0]["locked_until"])}


def set_pin(caller: Caller, pin: str, current_pin: str | None = None) -> dict[str, Any]:
    if not PIN_RX.match(pin or ""):
        raise BadRequest("The signing PIN must be 6 to 12 digits.")
    lb = lakebase.get()
    r = lb.query(f"SELECT pin_hash FROM {repo.S()}.signing_pin WHERE email = %s", (caller.email,))
    if r:
        if not current_pin or not check_pin(current_pin, r[0]["pin_hash"]):
            raise Forbidden("Enter your current signing PIN to change it.")
    lb.execute(f"INSERT INTO {repo.S()}.signing_pin (email, pin_hash) VALUES (%s, %s) ON CONFLICT (email) DO UPDATE "
               f"SET pin_hash = EXCLUDED.pin_hash, set_at = now(), failed = 0, locked_until = NULL", (caller.email, hash_pin(pin)))
    repo.audit(lb, caller.email, "esign.pin_set" if not r else "esign.pin_changed", "signer", caller.email, {})
    return pin_status(caller)


def reset_pin(admin: Caller, email: str, reason: str) -> None:
    lb = lakebase.get()
    n = lb.execute(f"DELETE FROM {repo.S()}.signing_pin WHERE email = %s", (email.lower(),))
    if not n:
        raise Conflict(f"{email} has no signing PIN.")
    repo.audit(lb, admin.email, "esign.pin_reset", "signer", email.lower(), {"reason": reason})


def verify(caller: Caller, pin: str | None) -> None:
    """Check the second component; count failures and lock after MAX_FAILED."""
    lb = lakebase.get()
    r = lb.query(f"SELECT pin_hash, failed, locked_until FROM {repo.S()}.signing_pin WHERE email = %s", (caller.email,))
    if not r:
        raise Conflict("Set your signing PIN first (your initials menu, top right).")
    row = r[0]
    now = datetime.now(timezone.utc)
    if row["locked_until"] and row["locked_until"] > now:
        raise Forbidden(f"Signing is locked until {row['locked_until']:%H:%M} UTC after {MAX_FAILED} wrong PINs.")
    if not pin or not check_pin(pin, row["pin_hash"]):
        failed = int(row["failed"]) + 1
        lock = now + timedelta(minutes=LOCK_MINUTES) if failed >= MAX_FAILED else None
        lb.execute(f"UPDATE {repo.S()}.signing_pin SET failed = %s, locked_until = %s WHERE email = %s",
                   (0 if lock else failed, lock, caller.email))
        repo.audit(lb, caller.email, "esign.failed", "signer", caller.email, {"failed": failed, "locked": bool(lock)})
        raise Forbidden("Wrong signing PIN." + (f" Signing is locked for {LOCK_MINUTES} minutes." if lock else ""))
    lb.execute(f"UPDATE {repo.S()}.signing_pin SET failed = 0, locked_until = NULL WHERE email = %s", (caller.email,))


def sign(caller: Caller, rid: str, version: int, config_hash: str, meaning: str, reason: str, pin: str | None,
         printed_name: str | None = None) -> dict[str, Any]:
    if meaning not in MEANINGS:
        raise BadRequest(f"Signature meaning must be one of {', '.join(MEANINGS)}.")
    verify(caller, pin)
    signed_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    name = (printed_name or caller.name or caller.email).strip()[:120]
    mh = manifest_hash(caller.email, meaning, signed_at, rid, version, config_hash)
    lb = lakebase.get()
    lb.execute(f"INSERT INTO {repo.S()}.e_signature (request_id, version, config_hash, signer, printed_name, meaning, reason, signed_at, manifest_hash) "
               f"VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)", (rid, version, config_hash, caller.email, name, meaning, reason, signed_at, mh))
    repo.audit(lb, caller.email, "esign.sign", "request", rid, {"meaning": meaning, "version": version, "manifest": mh[:16], "reason": reason})
    return {"signer": caller.email, "printed_name": name, "meaning": meaning, "signed_at": signed_at, "manifest_hash": mh}


def signatures(rid: str) -> list[dict[str, Any]]:
    rows = lakebase.get().query(f"SELECT request_id, version, config_hash, signer, printed_name, meaning, reason, signed_at, manifest_hash "
                                f"FROM {repo.S()}.e_signature WHERE request_id = %s ORDER BY signed_at", (rid,))
    out = []
    for r in rows:
        r = repo.row(r)
        signed_at = r["signed_at"]
        # the stored timestamp round-trips through Postgres; recompute from the canonical ISO form we sealed
        canon = datetime.fromisoformat(signed_at).astimezone(timezone.utc).isoformat(timespec="seconds")
        r["intact"] = manifest_hash(r["signer"], r["meaning"], canon, r["request_id"], r["version"], r["config_hash"]) == r["manifest_hash"]
        out.append(r)
    return out
