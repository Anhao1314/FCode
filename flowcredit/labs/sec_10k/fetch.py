"""Offline SEC 10-K fetch and deterministic excerpt builder.

The runtime never imports this module. It is a lab-only script with a single
purpose: download one pinned 10-K primary document (or discover the latest
10-K), convert it to stable text, and write the small committed excerpt plus
metadata.

SEC fair-access rules are respected: a caller-supplied ``SEC_USER_AGENT`` is
required, requests are spaced by at least 0.2 seconds, and the contact is never
written into the repository or printed.

Usage::

    cd flowcredit
    SEC_USER_AGENT='FCode research <you@example.com>' \
        python3.12 -m labs.sec_10k.fetch --reuse-raw

The default filing is pinned to Cisco's FY2025 10-K. IBM's FY2025/FY2026
primary documents incorporate the financial statements by reference to the
Annual Report exhibit, so the primary HTML cannot satisfy the single-document
extraction rule. Cisco's primary contains the consolidated statements, and
FY2025 is the period the production credit planner and memo use.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

if __package__ in (None, ""):  # allow `python labs/sec_10k/fetch.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from labs.sec_10k.html_to_text import convert_html, write_lines
else:
    from .html_to_text import convert_html, write_lines

__all__ = ["DEFAULT_CIK", "DEFAULT_ACCESSION", "build_excerpt", "main"]

LAB_DIR = Path(__file__).resolve().parent
DATA_DIR = LAB_DIR / "data"
RAW_DIR = DATA_DIR / "raw"

DEFAULT_CIK = "0000858877"
DEFAULT_ACCESSION = "0000858877-25-000111"
DEFAULT_PRIMARY = "csco-20250726.htm"
DEFAULT_FILING_DATE = "2025-09-03"
DEFAULT_REPORT_DATE = "2025-07-26"
DEFAULT_COMPANY = "Cisco Systems, Inc."
DEFAULT_TICKER = "CSCO"
DEFAULT_URL = (
    "https://www.sec.gov/Archives/edgar/data/858877/"
    "000085887725000111/csco-20250726.htm"
)
DEFAULT_SHA256 = "36be983637c033c8c03ffcbbc404f1cda0a437f6951959aab7f5cd124978b423"
REQUEST_PAUSE_SECONDS = 0.2


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _request(url: str, user_agent: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": user_agent,
            "Accept-Encoding": "identity",
            "Accept": "text/html,application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = response.read()
    time.sleep(REQUEST_PAUSE_SECONDS)
    return payload


def _submissions(cik: str, user_agent: str) -> dict[str, Any]:
    url = f"https://data.sec.gov/submissions/CIK{cik.zfill(10)}.json"
    return json.loads(_request(url, user_agent).decode("utf-8"))


def _find_latest_10k(cik: str, user_agent: str) -> dict[str, str]:
    submissions = _submissions(cik, user_agent)
    recent = submissions["filings"]["recent"]
    for form, accession, filed, report, primary in zip(
        recent["form"],
        recent["accessionNumber"],
        recent["filingDate"],
        recent["reportDate"],
        recent["primaryDocument"],
    ):
        if form == "10-K":
            return {
                "accession": accession,
                "filing_date": filed,
                "report_date": report,
                "primary_document": primary,
                "company": submissions.get("name", ""),
            }
    raise SystemExit("no 10-K found in the recent submissions feed")


def _section(
    lines: list[str],
    start_text: str,
    end_prefix: str,
    *,
    start_after: int = 0,
    end_after: int | None = None,
) -> tuple[int, int]:
    """Return a 1-based inclusive range from an exact heading to an end prefix."""
    start = None
    for index in range(start_after, len(lines)):
        if lines[index].strip() == start_text:
            start = index
            break
    if start is None:
        raise ValueError(f"excerpt anchor not found: {start_text!r}")
    end = None
    search_from = start + 1 if end_after is None else max(start + 1, end_after)
    for index in range(search_from, len(lines)):
        if lines[index].startswith(end_prefix):
            end = index
            break
    if end is None:
        raise ValueError(f"excerpt end not found after {start_text!r}: {end_prefix!r}")
    return start + 1, end + 1


def build_excerpt(lines: list[str]) -> list[str]:
    """Build the deterministic committed excerpt from the full text lines."""
    audit_start, audit_end = _section(
        lines,
        "Report of Independent Registered Public Accounting Firm",
        "In our opinion,",
    )
    balance_start, balance_end = _section(
        lines,
        "Consolidated Balance Sheets",
        "TOTAL LIABILITIES AND EQUITY",
        start_after=audit_end,
    )
    income_start, income_end = _section(
        lines,
        "Consolidated Statements of Operations",
        "NET INCOME",
        start_after=balance_end,
    )
    cash_start, cash_end = _section(
        lines,
        "Consolidated Statements of Cash Flows",
        "Net cash provided by operating activities",
        start_after=income_end,
    )

    total_debt_index = next(
        (index for index, line in enumerate(lines) if line.startswith("Total debt |")),
        None,
    )
    if total_debt_index is None:
        raise ValueError("excerpt anchor not found: 'Total debt |'")
    mdna_start = max(1, total_debt_index - 4)
    mdna_end = min(len(lines), total_debt_index + 6)

    note_start, note_end = _section(
        lines,
        "12.Borrowings",
        "Total |",
        start_after=total_debt_index,
    )

    sections = (
        ("### AUDIT REPORT", audit_start, audit_end),
        ("### CONSOLIDATED BALANCE SHEETS", balance_start, balance_end),
        ("### CONSOLIDATED STATEMENTS OF OPERATIONS", income_start, income_end),
        ("### CONSOLIDATED STATEMENTS OF CASH FLOWS", cash_start, cash_end),
        ("### MD&A TOTAL DEBT", mdna_start, mdna_end),
        ("### NOTE 12 BORROWINGS", note_start, note_end),
    )
    excerpt: list[str] = []
    for marker, start, end in sections:
        excerpt.append(marker)
        excerpt.extend(lines[start - 1:end])
    return excerpt


def _write_meta(
    *,
    path: Path,
    company: str,
    cik: str,
    ticker: str,
    accession: str,
    filing_date: str,
    report_date: str,
    primary: str,
    url: str,
    sha256: str,
    excerpt: list[str],
) -> None:
    meta = {
        "company": company,
        "cik": cik.zfill(10),
        "ticker": ticker,
        "accession": accession,
        "form": "10-K",
        "fiscal_year": "FY2025",
        "fiscal_year_end": report_date,
        "filing_date": filing_date,
        "primary_document": primary,
        "source_url": url,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "sha256": sha256,
        "excerpt_sha256": hashlib.sha256(
            ("\n".join(excerpt) + "\n").encode("utf-8")
        ).hexdigest(),
        "source_unit": "USD millions",
        "synthetic": False,
        "research_only": True,
        "selection_note": (
            "IBM primary 10-K incorporates the financial statements by reference; "
            "Cisco FY2025 primary contains them and matches the production planner's FY2025 period."
        ),
    }
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch and excerpt one SEC 10-K")
    parser.add_argument("--cik", default=DEFAULT_CIK)
    parser.add_argument("--accession", default=DEFAULT_ACCESSION)
    parser.add_argument("--latest", action="store_true", help="discover the latest 10-K instead of the pinned one")
    parser.add_argument("--reuse-raw", action="store_true", help="use data/raw instead of downloading")
    args = parser.parse_args(argv)

    user_agent = os.environ.get("SEC_USER_AGENT", "").strip()
    if not user_agent:
        raise SystemExit(
            "SEC_USER_AGENT is not set. Set it to 'FCode research <contact>' "
            "in your shell before running this lab script."
        )

    accession = args.accession
    filing_date = DEFAULT_FILING_DATE
    report_date = DEFAULT_REPORT_DATE
    primary = DEFAULT_PRIMARY
    company = DEFAULT_COMPANY
    url = DEFAULT_URL
    if args.latest:
        latest = _find_latest_10k(args.cik, user_agent)
        accession = latest["accession"]
        filing_date = latest["filing_date"]
        report_date = latest["report_date"]
        primary = latest["primary_document"]
        company = latest["company"] or DEFAULT_COMPANY
        url = (
            f"https://www.sec.gov/Archives/edgar/data/{int(args.cik)}/"
            f"{accession.replace('-', '')}/{primary}"
        )

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    raw_path = RAW_DIR / f"{accession}.html"
    if args.reuse_raw:
        if not raw_path.exists():
            raise SystemExit(f"raw filing not found: {raw_path}")
    else:
        raw_path.write_bytes(_request(url, user_agent))

    raw_bytes = raw_path.read_bytes()
    sha256 = hashlib.sha256(raw_bytes).hexdigest()
    if args.reuse_raw and accession == DEFAULT_ACCESSION and sha256 != DEFAULT_SHA256:
        raise SystemExit(
            f"raw filing sha256 mismatch: {sha256} != {DEFAULT_SHA256}; "
            "re-fetch or remove --reuse-raw"
        )

    html = raw_bytes.decode("utf-8", errors="replace")
    full_lines = convert_html(html)
    excerpt = build_excerpt(full_lines)
    if not 80 <= len(excerpt) <= 150:
        raise SystemExit(f"excerpt has {len(excerpt)} lines; expected 80-150")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    write_lines(excerpt, DATA_DIR / "excerpt.txt")
    _write_meta(
        path=DATA_DIR / "meta.json",
        company=company,
        cik=args.cik,
        ticker=DEFAULT_TICKER,
        accession=accession,
        filing_date=filing_date,
        report_date=report_date,
        primary=primary,
        url=url,
        sha256=sha256,
        excerpt=excerpt,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "company": company,
                "accession": accession,
                "excerpt_lines": len(excerpt),
                "sha256": sha256,
                "raw_path": str(raw_path),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
