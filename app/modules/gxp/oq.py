"""GxP operational qualification of one deployed request + its evidence pack.

Every check reads the REAL deployed state (Pipelines API, Jobs API, Unity Catalog, the event log, the audit trail)
and compares it with the APPROVED configuration version. The run is stored in Lakebase (gxp_evidence) with the SHA-256
of its canonical JSON, and the evidence ZIP is written to the UC volume <catalog>.<schema>.gxp_evidence.
"""
from __future__ import annotations

import csv
import hashlib
import html
import io
import json
import zipfile
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

from psycopg.types.json import Jsonb

from core import config, lakebase, repo
from core.errors import Conflict, NotFound
from core.identity import Caller
from modules.deploy import specs
from modules.gxp import esign
from modules.requests import rules
from modules.uc_access import service as uc_access

REQUIRED_EVENTS = ["request.create", "request.submit", "request.approve", "request.deploy", "request.live"]


def canonical_sha256(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def _c(key: str, label: str, ok: bool | None, detail: str, req: str) -> dict[str, Any]:
    status = "warn" if ok is None else ("pass" if ok else "fail")
    return {"key": key, "label": label, "status": status, "detail": detail, "requirement": req}


def run(rid: str, caller: Caller, w: Any | None = None) -> dict[str, Any]:
    lb = lakebase.get()
    r = repo.get_request(lb, rid)
    if not r:
        raise NotFound(rid)
    if r["status"] != "live":
        raise Conflict("Operational qualification runs on a live request.")
    w = w or lakebase.workspace_client()
    v = repo.get_version(lb, rid, r["version"]) or {}
    cfg = rules.normalize(v.get("config") or {})
    checks: list[dict[str, Any]] = []

    # 1 configuration integrity: the stored hash is the hash of the stored config
    checks.append(_c("config.integrity", "Approved configuration is intact", specs.config_hash(v.get("config") or {}) == v.get("config_hash"),
                     f"version {r['version']} sha256 {str(v.get('config_hash'))[:16]}…", "URS-03 versioned, tamper-evident configuration"))
    # 2 deployed pipeline = approved spec (no drift), run as the SP
    sp = uc_access.sp_identity(w)
    try:
        p = w.api_client.do("GET", f"/api/2.0/pipelines/{r['pipeline_id']}") or {}
        spec = p.get("spec") or {}
        want = {f"{o['schema']}.{o['table']}" for o in cfg["objects"]}
        got = set()
        for ob in ((spec.get("ingestion_definition") or {}).get("objects") or []):
            t = ob.get("table") or {}
            got.add(f"{t.get('source_schema')}.{t.get('source_table')}")
        drift = []
        if spec.get("catalog") != cfg["destination"]["catalog"] or spec.get("schema") != cfg["destination"]["schema"]:
            drift.append("destination")
        if spec.get("ingestion_definition") and got != want:
            drift.append(f"objects {sorted(got ^ want)}")
        if (spec.get("tags") or {}).get("dis_request") != rid:
            drift.append("tags")
        checks.append(_c("deploy.no_drift", "Deployed pipeline matches the approved configuration", not drift,
                         "Destination, objects and tags match." if not drift else f"Drift: {', '.join(drift)}", "URS-05 no manual changes"))
        who = p.get("run_as_user_name") or p.get("creator_user_name")
        checks.append(_c("runtime.identity", "Pipeline runs as the service principal", who == sp, f"run as {who}", "URS-07 headless runtime identity"))
        ups = p.get("latest_updates") or []
        done = any(u.get("state") == "COMPLETED" for u in ups)
        checks.append(_c("runtime.first_load", "Initial load completed", done, f"latest update {ups[0].get('state') if ups else 'none'}", "URS-08 data available"))
    except Exception as e:  # noqa: BLE001
        checks.append(_c("deploy.no_drift", "Deployed pipeline matches the approved configuration", False, f"pipeline unreadable: {e}", "URS-05"))
    # 3 Lakeflow validation step
    steps = {s["step"]: s for s in repo.list_steps(lb, rid, r["version"])}
    pv = steps.get("pipeline") or {}
    checks.append(_c("deploy.validated", "Lakeflow validated the definition before the first run",
                     pv.get("status") == "done" and "validated" in (pv.get("detail") or ""), pv.get("detail") or "no step", "URS-06 validated before use"))
    # 4 reconciliation
    rec = repo.latest_recon(lb, rid)
    if rec:
        mism = [x for x in rec if x["status"] != "match"]
        checks.append(_c("data.reconciled", "Source and destination row counts reconcile", not mism,
                         ", ".join(f"{x['table_name']} {x['source_rows']}→{x['target_rows']}" for x in rec), "URS-09 complete and accurate transfer"))
    else:
        checks.append(_c("data.reconciled", "Source and destination row counts reconcile", None, "no reconciliation yet", "URS-09"))
    # 5 access model
    for a in uc_access.verify(r, cfg, w):
        checks.append({**a, "requirement": "URS-10 least privilege (source SP-only, readers SELECT-only)"})
    # 6 schedule
    if r.get("job_id"):
        try:
            j = w.api_client.do("GET", "/api/2.2/jobs/get", query={"job_id": r["job_id"]}) or {}
            cron = ((j.get("settings") or {}).get("schedule") or {}).get("quartz_cron_expression")
            want = specs.quartz(cfg["schedule"]["interval_minutes"])
            checks.append(_c("deploy.schedule", "Schedule matches the approved refresh", cron == want, f"{cron} (approved {want})", "URS-05"))
        except Exception as e:  # noqa: BLE001
            checks.append(_c("deploy.schedule", "Schedule matches the approved refresh", None, f"job unreadable: {type(e).__name__}", "URS-05"))
    # 7 event log published
    el = f"{config.UC_CATALOG}.{config.UC_SCHEMA}.{specs.names(rid, {})['event_log']}"
    try:
        w.api_client.do("GET", f"/api/2.1/unity-catalog/tables/{quote(el, safe='')}")
        checks.append(_c("records.event_log", "Pipeline event log is retained in Unity Catalog", True, el, "URS-11 run history retained"))
    except Exception:  # noqa: BLE001
        checks.append(_c("records.event_log", "Pipeline event log is retained in Unity Catalog", False, f"{el} not found", "URS-11"))
    # 8 audit trail + approvals + signatures
    trail = repo.list_audit(lb, "request", rid, limit=1000)
    actions = [a["action"] for a in trail]
    missing = [e for e in REQUIRED_EVENTS if e not in actions]
    checks.append(_c("records.audit_trail", "Audit trail is complete", not missing,
                     f"{len(trail)} entries" + (f"; missing {missing}" if missing else ""), "URS-12 attributable, contemporaneous records"))
    approvers = [a["actor"] for a in trail if a["action"] == "request.approve"]
    checks.append(_c("approval.independent", "Approved by someone other than the requester",
                     bool(approvers) and all(x != r["requester"] for x in approvers), f"requester {r['requester']}, approver(s) {approvers}", "URS-13 segregation of duties"))
    if r.get("gxp"):
        sigs = [s for s in esign.signatures(rid) if s["version"] == r["version"] and s["meaning"] in ("Approved", "Released to UAT", "Released to Production")]
        intact = sigs and all(s["intact"] and s["config_hash"] == v.get("config_hash") for s in sigs)
        checks.append(_c("esign.bound", "Electronic signature present, intact and bound to this version", bool(intact),
                         "; ".join(f"{s['printed_name']} · {s['meaning']} · {s['signed_at']}" for s in sigs) or "no signature", "21 CFR 11.50 / 11.70 / 11.200"))
    verdict = "FAIL" if any(c["status"] == "fail" for c in checks) else ("PASS_WITH_DEVIATIONS" if any(c["status"] == "warn" for c in checks) else "PASS")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    result = {"request_id": rid, "version": r["version"], "config_hash": v.get("config_hash"), "pipeline_id": r.get("pipeline_id"),
              "job_id": r.get("job_id"), "environment": cfg["destination"]["environment"], "gxp": bool(r.get("gxp")),
              "verdict": verdict, "checks": checks, "generated_at": now, "generated_by": caller.email}
    sha = canonical_sha256(result)
    pack = evidence_zip(result, cfg, r, v, trail, esign.signatures(rid))
    path = _store(rid, r["version"], now, pack)
    row = lb.query(f"INSERT INTO {repo.S()}.gxp_evidence (request_id, version, kind, verdict, results, sha256, volume_path, created_by) "
                   f"VALUES (%s,%s,'oq',%s,%s,%s,%s,%s) RETURNING id", (rid, r["version"], verdict, Jsonb(result), sha, path, caller.email))
    repo.audit(lb, caller.email, "gxp.oq", "request", rid, {"verdict": verdict, "sha256": sha[:16], "evidence": path})
    return {**result, "id": row[0]["id"], "sha256": sha, "volume_path": path}


def _store(rid: str, version: int, at: str, pack: bytes) -> str | None:
    if not config.UC_CATALOG:
        return None
    path = f"/Volumes/{config.UC_CATALOG}/{config.UC_SCHEMA}/gxp_evidence/{rid}/{rid}-v{version}-oq-{at.replace(':', '').replace('-', '')}.zip"
    try:
        w = lakebase.workspace_client()
        w.files.upload(path, io.BytesIO(pack), overwrite=True)
        return path
    except Exception:  # noqa: BLE001 - the pack is still downloadable from the app; the row records no path
        return None


def latest(rid: str) -> dict[str, Any] | None:
    r = lakebase.get().query(f"SELECT id, request_id, version, kind, verdict, results, sha256, volume_path, created_by, created_at "
                             f"FROM {repo.S()}.gxp_evidence WHERE request_id = %s ORDER BY created_at DESC LIMIT 1", (rid,))
    return repo.row(r[0]) if r else None


def _csv(rows: list[dict[str, Any]], cols: list[str]) -> bytes:
    buf = io.StringIO()
    wr = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
    wr.writeheader()
    for x in rows:
        wr.writerow({k: (json.dumps(x[k], default=str) if isinstance(x.get(k), (dict, list)) else x.get(k)) for k in cols})
    return buf.getvalue().encode()


def render_html(result: dict[str, Any], cfg: dict[str, Any], sigs: list[dict[str, Any]]) -> str:
    e = html.escape
    rows = "".join(f"<tr><td>{e(c['key'])}</td><td>{e(c['label'])}</td><td class='{c['status']}'>{c['status'].upper()}</td>"
                   f"<td>{e(str(c.get('detail', '')))}</td><td>{e(c.get('requirement', ''))}</td></tr>" for c in result["checks"])
    srows = "".join(f"<tr><td>{e(s['printed_name'])}</td><td>{e(s['signer'])}</td><td>{e(s['meaning'])}</td><td>{e(str(s['signed_at']))}</td>"
                    f"<td>{e(s['reason'])}</td><td>{'intact' if s['intact'] else 'BROKEN'}</td></tr>" for s in sigs) or "<tr><td colspan=6>none</td></tr>"
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>OQ {e(result['request_id'])}</title>
<style>body{{font:14px system-ui;margin:32px;color:#1d1530}}h1{{font-weight:300}}table{{border-collapse:collapse;width:100%;margin:12px 0}}
td,th{{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}}th{{background:#f3efe9}}.pass{{color:#0a7a4f}}.fail{{color:#b3261e}}.warn{{color:#a15c00}}</style></head><body>
<h1>Operational qualification · {e(result['request_id'])} v{result['version']}</h1>
<p><b>Verdict: {e(result['verdict'])}</b> · generated {e(result['generated_at'])} by {e(result['generated_by'])} · environment {e(result['environment'])} · GxP {result['gxp']}</p>
<p>Configuration SHA-256 <code>{e(str(result['config_hash']))}</code> · pipeline <code>{e(str(result['pipeline_id']))}</code> · job <code>{e(str(result['job_id']))}</code></p>
<h2>Checks</h2><table><tr><th>ID</th><th>Check</th><th>Result</th><th>Evidence</th><th>Requirement</th></tr>{rows}</table>
<h2>Electronic signatures (21 CFR 11.50)</h2><table><tr><th>Printed name</th><th>Signer</th><th>Meaning</th><th>Date / time (UTC)</th><th>Reason</th><th>Seal</th></tr>{srows}</table>
<h2>Approved configuration</h2><pre>{e(json.dumps(cfg, indent=2))}</pre></body></html>"""


def evidence_zip(result: dict[str, Any], cfg: dict[str, Any], r: dict[str, Any], v: dict[str, Any], trail: list[dict[str, Any]],
                 sigs: list[dict[str, Any]]) -> bytes:
    conn = {"id": cfg["source"]["connector"], "cdc_architecture": None}
    from modules.catalog import registry
    conn = registry.get(cfg["source"]["connector"]) or conn
    try:
        sp = specs.build(r["id"], cfg, conn, staging_catalog=config.UC_CATALOG, staging_schema=config.GATEWAY_STORAGE_SCHEMA,
                         event_log_catalog=config.UC_CATALOG, event_log_schema=config.UC_SCHEMA, gateway_id=r.get("gateway_id"))
    except Exception as e:  # noqa: BLE001
        sp = {"error": str(e)}
    stem = f"{r['id']}-v{r['version']}-oq"
    files: dict[str, bytes] = {
        "report.html": render_html(result, cfg, sigs).encode(),
        "report.json": json.dumps(result, indent=2, default=str).encode(),
        "approved_config.json": json.dumps({"version": r["version"], "config_hash": v.get("config_hash"), "config": cfg}, indent=2).encode(),
        "deployed_specs.json": json.dumps(sp, indent=2, default=str).encode(),
        "audit_trail.csv": _csv(trail, ["at", "actor", "action", "entity", "entity_id", "detail"]),
        "signatures.csv": _csv(sigs, ["printed_name", "signer", "meaning", "signed_at", "reason", "version", "config_hash", "manifest_hash", "intact"]),
    }
    files["README.txt"] = (f"Operational qualification evidence for {r['id']} version {r['version']} — verdict {result['verdict']}\n"
                           "report.html  human-readable report with signature manifestations\nreport.json  machine-readable result\n"
                           "approved_config.json / deployed_specs.json / audit_trail.csv / signatures.csv\n"
                           "checksums.sha256  verify with: shasum -a 256 -c checksums.sha256\n").encode()
    manifest = {"pack": stem, "verdict": result["verdict"], "result_sha256": canonical_sha256(result),
                "files": [{"path": p, "bytes": len(b), "sha256": hashlib.sha256(b).hexdigest()} for p, b in files.items()]}
    files["manifest.json"] = json.dumps(manifest, indent=2).encode()
    files["checksums.sha256"] = "".join(f"{hashlib.sha256(b).hexdigest()}  {p}\n" for p, b in files.items()).encode()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p, b in files.items():
            z.writestr(f"{stem}/{p}", b)
    return buf.getvalue()


def pack_for(rid: str) -> tuple[str, bytes]:
    """Rebuild the ZIP of the latest OQ run (from the stored result) for download."""
    lb = lakebase.get()
    ev = latest(rid)
    if not ev:
        raise NotFound("No qualification run yet.")
    r = repo.get_request(lb, rid) or {}
    v = repo.get_version(lb, rid, ev["version"]) or {}
    cfg = rules.normalize(v.get("config") or {})
    pack = evidence_zip(ev["results"], cfg, r, v, repo.list_audit(lb, "request", rid, limit=1000), esign.signatures(rid))
    return f"{rid}-v{ev['version']}-oq.zip", pack

