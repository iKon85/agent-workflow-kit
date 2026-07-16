"""Load the shipped Safety Guardrails core for thin hook adapters."""

import importlib.util
import sys
from pathlib import Path

_CORE_MODULE = "_agent_workflow_kit_safety_guardrails"


def load_core():
    existing = sys.modules.get(_CORE_MODULE)
    if existing is not None:
        return existing
    path = Path(__file__).resolve().parents[2] / "scripts" / "safety-guardrails" / "core.py"
    module_dir = str(path.parent)
    if module_dir not in sys.path:
        sys.path.insert(0, module_dir)
    spec = importlib.util.spec_from_file_location(_CORE_MODULE, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load Safety Guardrails core from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_CORE_MODULE] = module
    spec.loader.exec_module(module)
    return module
