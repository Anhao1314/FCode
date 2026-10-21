"""Credit due-diligence tools: a production domain, not a lab.

The package owns the synthetic issuer corpus, the eight metric contracts, the
blueprint planner and the independent verifier. The kernel still knows none of
those nouns; it only knows a ``DomainModule`` and a declared result tool.
"""

from __future__ import annotations

__all__ = ["world", "tools", "planner", "verifier", "memo"]
