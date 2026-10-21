#!/usr/bin/env python3
"""Root entry point for the credit due-diligence demo.

Usage::

    python credit_demo.py --issuer hengxing
    python credit_demo.py --issuer yuanyang
    python credit_demo.py --issuer yunling
    python credit_demo.py --all
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))

from flowagent.demo.credit import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
