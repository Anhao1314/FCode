"""Offline SEC 10-K fetch and profile-driven excerpt builder.

The runtime never imports this module. It is a lab-only script: download one
10-K primary document (or discover the latest one), convert it to stable text,
and write the committed excerpt plus metadata under ``data/<issuer>/``.

SEC fair-access rules are respected: a caller-supplied ``SEC_USER_AGENT`` is
required, requests are spaced by at least 0.2 seconds, and the contact is never
written into the repository or printed.

Usage::

    cd flowcredit
    SEC_USER_AGENT='FCode research <you@example.com>' \
        python3.12 -m labs.sec_10k.fetch --issuer cisco --reuse-raw
    SEC_USER_AGENT='FCode research <you@example.com>' \
        python3.12 -m labs.sec_10k.fetch --issuer home-depot --latest

The issuer's ``profile.json`` carries the excerpt anchors. No issuer's CIK,
accession or primary-document name lives in this module.
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
    from labs.sec_10k.profiles import FilingProfile, load_profile
else:
    from .html_to_text import convert_html, write_lines
    from .profiles import FilingProfile, load_profile

__all__ = ["build_excerpt", "main"]

LAB_DIR = Path(__file__).resolve().parent
DATA_ROOT = LAB_DIR / "data"
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


def _find_exact(lines: list[str], text: str, start: int = 0) -> int:
    for index in range(max(0, start), len(lines)):
        if lines[index].strip() == text:
            return index
    raise ValueError(f"excerpt anchor not found: {text!r}")


def _find_prefix(lines: list[str], prefix: str, start: int = 0) -> int:
    for index in range(max(0, start), len(lines)):
        if lines[index].startswith(prefix):
            return index
    raise ValueError(f"excerpt end not found: {prefix!r}")


def _find_anchor(lines: list[str], anchor: str, start: int = 0) -> int:
    for index in range(max(0, start), len(lines)):
        if lines[index].startswith(anchor):
            return index
    raise ValueError(f"excerpt anchor not found: {anchor!r}")


def _excerpt_range(
    lines: list[str],
    rule: Any,
    cursor: int,
) -> tuple[int, int]:
    """Return 0-based inclusive ``(start, end)`` for one profile rule."""
    if rule.mode == "between":
        search_from = cursor
        if rule.after_anchor:
            anchor = _find_anchor(lines, rule.after_anchor)
            search_from = max(search_from, anchor + 1)
        start = _find_exact(lines, rule.start, search_from)
        end = _find_prefix(lines, rule.end_prefix, start + 1)
        return start, end
    if rule.mode == "around":
        # An around-rule names a global anchor; its section may appear earlier
        # in the document than the sequential statement sections.
        anchor = _find_anchor(lines, rule.anchor)
        return max(0, anchor - rule.before), min(len(lines) - 1, anchor + rule.after)
    raise ValueError(f"unknown excerpt mode: {rule.mode!r}")


def build_excerpt(lines: list[str], profile: FilingProfile) -> list[str]:
    """Build the deterministic committed excerpt from profile rules."""
    excerpt: list[str] = []
    cursor = 0
    for rule in profile.excerpt:
        start, end = _excerpt_range(lines, rule, cursor)
        excerpt.append(rule.marker)
        excerpt.extend(lines[start:end + 1])
        cursor = end + 1
    return excerpt


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


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
    fiscal_year: str,
    prior_fiscal_year: str,
    source_unit: str,
    selection_note: str,
    retrieved_at: str,
) -> None:
    meta = {
        "company": company,
        "cik": cik.zfill(10),
        "ticker": ticker,
        "accession": accession,
        "form": "10-K",
        "fiscal_year": fiscal_year,
        "prior_fiscal_year": prior_fiscal_year,
        "fiscal_year_end": report_date,
        "filing_date": filing_date,
        "primary_document": primary,
        "source_url": url,
        "retrieved_at": retrieved_at,
        "sha256": sha256,
        "excerpt_sha256": (
            hashlib.sha256(("\n".join(excerpt) + "\n").encode("utf-8")).hexdigest()
            if excerpt
            else ""
        ),
        "source_unit": source_unit,
        "synthetic": False,
        "research_only": True,
        "selection_note": selection_note,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch and excerpt one SEC 10-K")
    parser.add_argument("--issuer", required=True, help="issuer key; data/<issuer>/")
    parser.add_argument("--cik", default="", help="override the profile/meta CIK")
    parser.add_argument("--company", default="", help="override the company name")
    parser.add_argument("--accession", default="", help="pin an accession instead of discovering")
    parser.add_argument("--primary", default="", help="primary document for a pinned accession")
    parser.add_argument("--latest", action="store_true", help="discover the latest 10-K")
    parser.add_argument("--reuse-raw", action="store_true", help="use data/<issuer>/raw instead of downloading")
    parser.add_argument("--download-only", action="store_true", help="download and write meta, skip the excerpt")
    parser.add_argument("--fiscal-year", default="", help="label for the current column, e.g. FY2025")
    parser.add_argument("--prior-fiscal-year", default="", help="label for the comparative column, e.g. FY2024")
    args = parser.parse_args(argv)

    user_agent = os.environ.get("SEC_USER_AGENT", "").strip()
    if not user_agent:
        raise SystemExit(
            "SEC_USER_AGENT is not set. Set it to 'FCode research <contact>' "
            "in your shell before running this lab script."
        )

    base = DATA_ROOT / args.issuer
    meta_path = base / "meta.json"
    profile_path = base / "profile.json"
    meta = _load_json(meta_path)
    profile = load_profile(profile_path) if profile_path.exists() else None

    cik = args.cik or (profile.cik if profile else "") or str(meta.get("cik") or "")
    if not cik:
        raise SystemExit("no CIK: pass --cik or provide data/<issuer>/profile.json")
    cik = cik.zfill(10)

    latest: dict[str, str] = {}
    if args.accession:
        accession = args.accession
        primary = args.primary or str(meta.get("primary_document") or "")
        filing_date = str(meta.get("filing_date") or "")
        report_date = str(meta.get("fiscal_year_end") or "")
        company = args.company or str(meta.get("company") or "")
        if not primary:
            raise SystemExit("pinned accession needs --primary or an existing meta.json")
    elif args.latest or not meta.get("accession"):
        latest = _find_latest_10k(cik, user_agent)
        accession = latest["accession"]
        primary = latest["primary_document"]
        filing_date = latest["filing_date"]
        report_date = latest["report_date"]
        company = args.company or (profile.company if profile else "") or latest["company"]
    else:
        accession = str(meta["accession"])
        primary = str(meta["primary_document"])
        filing_date = str(meta.get("filing_date") or "")
        report_date = str(meta.get("fiscal_year_end") or "")
        company = args.company or str(meta.get("company") or "")
    if not company:
        company = args.company or (profile.company if profile else "") or str(meta.get("company") or "")

    url = (
        f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/"
        f"{accession.replace('-', '')}/{primary}"
    )
    raw_dir = base / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / ".gitignore").write_text("*\n!.gitignore\n", encoding="utf-8")
    raw_path = raw_dir / f"{accession}.html"
    if args.reuse_raw:
        if not raw_path.exists():
            raise SystemExit(f"raw filing not found: {raw_path}")
    else:
        raw_path.write_bytes(_request(url, user_agent))

    raw_bytes = raw_path.read_bytes()
    sha256 = hashlib.sha256(raw_bytes).hexdigest()
    if args.reuse_raw and meta.get("sha256") and sha256 != meta["sha256"]:
        raise SystemExit(
            f"raw filing sha256 mismatch: {sha256} != {meta['sha256']}; "
            "re-fetch or remove --reuse-raw"
        )

    html = raw_bytes.decode("utf-8", errors="replace")
    full_lines = convert_html(html)
    excerpt: list[str] = []
    if not args.download_only and profile is not None:
        excerpt = build_excerpt(full_lines, profile)
        if not 80 <= len(excerpt) <= 150:
            raise SystemExit(f"excerpt has {len(excerpt)} lines; expected 80-150")
        write_lines(excerpt, base / "excerpt.txt")

    fiscal_year = (
        args.fiscal_year
        or (profile.fiscal_year if profile else "")
        or str(meta.get("fiscal_year") or "")
    )
    prior_fiscal_year = (
        args.prior_fiscal_year
        or (profile.prior_fiscal_year if profile else "")
        or str(meta.get("prior_fiscal_year") or "")
    )
    source_unit = (
        (profile.source_unit if profile else "")
        or str(meta.get("source_unit") or "USD millions")
    )
    selection_note = (
        (profile.selection_note if profile else "")
        or str(meta.get("selection_note") or "")
    )
    ticker = (profile.ticker if profile else "") or str(meta.get("ticker") or "")
    retrieved_at = str(meta.get("retrieved_at") or datetime.now(timezone.utc).isoformat())

    _write_meta(
        path=meta_path,
        company=company,
        cik=cik,
        ticker=ticker,
        accession=accession,
        filing_date=filing_date,
        report_date=report_date,
        primary=primary,
        url=url,
        sha256=sha256,
        excerpt=excerpt,
        fiscal_year=fiscal_year or "FY2025",
        prior_fiscal_year=prior_fiscal_year or "FY2024",
        source_unit=source_unit,
        selection_note=selection_note,
        retrieved_at=retrieved_at,
    )
    print(
        json.dumps(
            {
                "ok": True,
                "issuer": args.issuer,
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
