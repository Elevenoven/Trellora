"""Trellora 本地解析 Worker。"""

import sys
from pathlib import Path


development_dependencies = Path(__file__).resolve().parents[1] / '.deps'
if development_dependencies.is_dir():
    dependency_path = str(development_dependencies)
    if dependency_path not in sys.path:
        sys.path.insert(0, dependency_path)

WORKER_VERSION = '0.3.0'
PROTOCOL_VERSION = 1
