"""Shared job bootstrap: `--root <bundle files>` + repeated `--env KEY=VALUE`, applied BEFORE any app import
(app/core/config.py reads the environment at import time; spark_python_task cannot set env vars itself)."""
from __future__ import annotations

import os
import sys


def init(argv: list[str] | None = None) -> str:
    argv = list(sys.argv[1:] if argv is None else argv)
    root = "."
    i = 0
    while i < len(argv):
        if argv[i] == "--root" and i + 1 < len(argv):
            root = argv[i + 1]
            i += 2
            continue
        if argv[i] == "--env" and i + 1 < len(argv):
            k, _, v = argv[i + 1].partition("=")
            if k and v and not os.environ.get(k):
                os.environ[k] = v
            i += 2
            continue
        i += 1
    app = os.path.join(root, "app")
    if app not in sys.path:
        sys.path.insert(0, app)
    return root
