"""Deterministic SEC HTML -> line-oriented text.

The converter is deliberately small and standard-library only. It emits one
line per block element and one line per table row; table cells are joined with
`` | ``. The resulting line numbers are the anchors used by the extractor and by
every citation in the credit spike.

No HTML library beyond :mod:`html.parser` is used, and no text is summarised or
rewritten: parentheses, percent signs, commas and currency symbols survive.
"""

from __future__ import annotations

from html.parser import HTMLParser
from typing import Iterable

__all__ = ["convert_html", "normalise_line"]

#: Block tags that end a paragraph in the plain-text rendering.
_BLOCK_TAGS = {
    "p", "div", "h1", "h2", "h3", "h4", "h5", "h6",
    "li", "section", "article", "header", "footer", "caption",
}
_SKIP_TAGS = {"script", "style", "head", "title"}


def normalise_line(text: str) -> str:
    """Collapse whitespace while preserving every visible character."""
    return " ".join(text.replace("\xa0", " ").split())


class _FilingParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.lines: list[str] = []
        self._text: list[str] = []
        self._table_depth = 0
        self._row: list[str] = []
        self._cell: list[str] | None = None
        self._skip_depth = 0

    # ------------------------------------------------------------------ parser

    def handle_starttag(self, tag: str, attrs) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == "table":
            self._flush_text()
            self._table_depth += 1
            return
        if self._table_depth:
            if tag == "tr":
                self._flush_cell()
                self._flush_row()
            elif tag in ("td", "th"):
                self._flush_cell()
                self._cell = []
            elif tag == "br" and self._cell is not None:
                self._cell.append(" ")
            return
        if tag == "br":
            self._text.append(" ")
        elif tag in _BLOCK_TAGS:
            self._flush_text()

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag == "table":
            self._flush_cell()
            self._flush_row()
            self._table_depth = max(0, self._table_depth - 1)
            self._flush_text()
            return
        if self._table_depth:
            if tag in ("td", "th"):
                self._flush_cell()
            elif tag == "tr":
                self._flush_cell()
                self._flush_row()
            return
        if tag in _BLOCK_TAGS:
            self._flush_text()

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._cell is not None:
            self._cell.append(data)
        elif self._table_depth:
            # Text directly inside a table but outside a cell (e.g. whitespace).
            return
        else:
            self._text.append(data)

    def close(self) -> None:
        super().close()
        self._flush_cell()
        self._flush_row()
        self._flush_text()

    # ------------------------------------------------------------------ output

    def _flush_text(self) -> None:
        line = normalise_line("".join(self._text))
        if line:
            self.lines.append(line)
        self._text = []

    def _flush_cell(self) -> None:
        if self._cell is None:
            return
        self._row.append(normalise_line("".join(self._cell)))
        self._cell = None

    def _flush_row(self) -> None:
        if not self._row:
            return
        # Keep empty cells only when they carry a position between non-empty
        # cells; trim leading/trailing padding cells so numeric columns stay
        # aligned without trailing separators.
        cells = list(self._row)
        while cells and not cells[0]:
            cells.pop(0)
        while cells and not cells[-1]:
            cells.pop()
        if cells:
            self.lines.append(" | ".join(cells))
        self._row = []


def convert_html(html: str) -> list[str]:
    """Return stable 1-based-indexable block/table lines."""
    parser = _FilingParser()
    parser.feed(html)
    parser.close()
    return parser.lines


def write_lines(lines: Iterable[str], path) -> None:
    """Write one line per text row, UTF-8, no trailing spaces."""
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        for line in lines:
            handle.write(line.rstrip() + "\n")
