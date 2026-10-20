"""Host-configured connectors: the only way a tool may touch the network.

The model never sees a URL. It names a source from a host-configured registry;
the registry owns the endpoint, the credentials, the timeout and the size cap.
That is the same authority split the rest of the runtime uses: the model may
propose *what* to ask, never *where* to send it.

Failure semantics are deliberately conservative:

* A timeout or transport failure raises ``CONNECTOR_TIMEOUT`` /
  ``CONNECTOR_UNKNOWN`` and is **not retried inside the tool**. Whether to try
  again is an operator decision (resume), not a convenience the tool hides.
* Credentials are resolved at call time and never copied into the result,
  the observation or the trace. Only header names could ever be logged, and we
  do not log even those.
* Responses are capped in bytes before parsing; a feed cannot exhaust memory.

Connectors are disabled by default. ``demo-feed`` exists so the catalog is
deterministic and the refusal is demonstrable offline.
"""

from __future__ import annotations

import hashlib
import json
import socket
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Mapping
from urllib.parse import urlencode

from ..core.contracts import AgentError

__all__ = ["Connector", "ConnectorRegistry"]

MAX_BYTES = 256 * 1024
TEXT_EXCERPT = 4000


@dataclass(frozen=True)
class Connector:
    name: str
    base_url: str
    enabled: bool = False
    timeout: float = 10.0
    max_bytes: int = MAX_BYTES
    query_param: str = "key"
    #: Resolved lazily on every call. Never placed in results or traces.
    credentials: Callable[[], Mapping[str, str]] | None = field(default=None, repr=False)


class ConnectorRegistry:
    """Named sources; the model may only pick from :meth:`names`."""

    def __init__(self, connectors: list[Connector] | None = None) -> None:
        self._by_name = {connector.name: connector for connector in connectors or []}

    def names(self) -> tuple[str, ...]:
        return tuple(sorted(self._by_name))

    def get(self, name: str) -> Connector:
        connector = self._by_name.get(name)
        if connector is None:
            raise AgentError("CONNECTOR_UNKNOWN", f"{name!r} is not a configured source")
        return connector

    def fetch(self, name: str, key: str | None = None) -> dict[str, Any]:
        connector = self.get(name)
        if not connector.enabled:
            raise AgentError(
                "CONNECTOR_DISABLED",
                f"{name!r} is configured but disabled by the host",
            )
        url = connector.base_url
        if key:
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}{urlencode({connector.query_param: key})}"
        headers = {"Accept": "application/json", "User-Agent": "fcode-connector/1"}
        if connector.credentials is not None:
            headers.update({str(k): str(v) for k, v in connector.credentials().items()})
        request_id = uuid.uuid4().hex
        request = urllib.request.Request(url, headers=headers, method="GET")
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=connector.timeout) as response:
                status = int(response.status)
                content_type = response.headers.get("Content-Type", "")
                data = response.read(connector.max_bytes + 1)
        except urllib.error.HTTPError as error:
            raise AgentError(
                "CONNECTOR_HTTP_ERROR",
                f"{name!r} answered HTTP {error.code}",
            ) from error
        except (TimeoutError, socket.timeout) as error:
            raise AgentError(
                "CONNECTOR_TIMEOUT",
                f"{name!r} timed out after {connector.timeout:.0f}s; not retried",
            ) from error
        except urllib.error.URLError as error:
            if isinstance(error.reason, (TimeoutError, socket.timeout)):
                raise AgentError(
                    "CONNECTOR_TIMEOUT",
                    f"{name!r} timed out after {connector.timeout:.0f}s; not retried",
                ) from error
            raise AgentError(
                "CONNECTOR_UNKNOWN",
                f"{name!r} transport failed; outcome unknown, not retried: {error.reason}",
            ) from error
        except OSError as error:
            raise AgentError(
                "CONNECTOR_UNKNOWN",
                f"{name!r} transport failed; outcome unknown, not retried: {error}",
            ) from error
        if len(data) > connector.max_bytes:
            raise AgentError(
                "CONNECTOR_TOO_LARGE",
                f"{name!r} exceeded {connector.max_bytes} bytes",
            )
        latency_ms = int((time.monotonic() - started) * 1000)
        if "json" in content_type.lower():
            try:
                payload: dict[str, Any] = {"json": json.loads(data.decode("utf-8"))}
            except ValueError:
                payload = {"text": data.decode("utf-8", errors="replace")[:TEXT_EXCERPT]}
        else:
            payload = {"text": data.decode("utf-8", errors="replace")[:TEXT_EXCERPT]}
        return {
            "source": name,
            "url": url,
            "status": status,
            "content_type": content_type,
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "payload": payload,
            "request_id": request_id,
            "latency_ms": latency_ms,
        }


def default_registry() -> ConnectorRegistry:
    """Deterministic catalog, network closed: one configured-but-disabled source."""
    return ConnectorRegistry([
        Connector(
            name="demo-feed",
            base_url="http://127.0.0.1:9/feed",
            enabled=False,
        ),
    ])
