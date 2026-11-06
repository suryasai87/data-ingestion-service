#!/usr/bin/env bash
# Offline tests: backend (pytest, real throwaway Postgres) + frontend (tsc + vitest). No network to Databricks.
#   scripts/test.sh            # both
#   scripts/test.sh live       # + live integration tests against $DIS_URL (creates real pipelines)
set -eo pipefail
cd "$(dirname "$0")/.."
UV=(uv run -q --no-project --python 3.11 --index-url https://pypi.org/simple/ --with pytest --with fastapi
    --with httpx --with "databricks-sdk==0.57.0" --with "psycopg[binary]" --with psycopg_pool --with numpy)
echo "== backend unit"; "${UV[@]}" python -m pytest tests/unit -q
echo "== frontend"; (cd frontend && npx tsc --noEmit && npx vitest run)
if [[ "${1:-}" == "live" ]]; then
  echo "== live ($DIS_URL)"; "${UV[@]}" python -m pytest tests/live -m live -q -s
fi
