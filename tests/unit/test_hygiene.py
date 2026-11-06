"""Shipped code must not hard-code a person's email or a workspace id (admins come from the deployer + the app)."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_no_personal_emails_or_workspace_ids_in_shipped_code():
    bad = []
    for p in list((ROOT / "app").rglob("*.py")) + list((ROOT / "jobs").rglob("*.py")) + list((ROOT / "frontend/src").rglob("*.tsx")):
        if "node_modules" in p.parts or ".test." in p.name:
            continue
        t = p.read_text(errors="ignore")
        if re.search(r"demouser|@databricks\.com|1234567890123456", t):
            bad.append(str(p.relative_to(ROOT)))
    assert not bad, bad


def test_no_customer_proprietary_tokens():
    bad = []
    for p in list((ROOT / "app").rglob("*.py")) + list((ROOT / "jobs").rglob("*.py")):
        if re.search(r"ZZ1_|CUST_|\bOMP_", p.read_text(errors="ignore")):
            bad.append(str(p))
    assert not bad, bad
