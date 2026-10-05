from __future__ import annotations

import json
import sys
import threading
from typing import Any


class ProtocolWriter:
    def __init__(self) -> None:
        self._lock = threading.Lock()

    def send(self, message: dict[str, Any]) -> None:
        # Worker stdout is an NDJSON transport, not an artifact file. Escaping
        # non-ASCII characters keeps the protocol safe even if a packaged
        # Windows runtime starts with a legacy console code page.
        line = json.dumps(message, ensure_ascii=True, separators=(',', ':'))
        with self._lock:
            sys.stdout.write(line + '\n')
            sys.stdout.flush()


def read_requests():
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            yield value


def configure_stdio_utf8() -> None:
    """Use UTF-8 for worker streams while tolerating embedded runtimes."""
    for stream, errors in ((sys.stdin, 'strict'), (sys.stdout, 'strict'), (sys.stderr, 'replace')):
        reconfigure = getattr(stream, 'reconfigure', None)
        if not callable(reconfigure):
            continue
        try:
            reconfigure(encoding='utf-8', errors=errors)
        except (AttributeError, OSError, ValueError):
            # Some test wrappers and frozen runtimes expose non-reconfigurable
            # streams. The protocol's ASCII-safe JSON remains the fallback.
            continue
