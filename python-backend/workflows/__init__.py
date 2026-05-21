"""Stage 6 workflow implementations.

Each workflow is an async generator yielding SSE-framed events conforming to
``CONTRACTS.md``. They use the snippet emitter for transport and the SDK
namespaces (``client.prompt``, ``client.evaluate.dataset``, ``client.tools``,
``client.evals``) for the real Sandbox calls.
"""
from __future__ import annotations

from .dataset_run import run_dataset_run
from .eval_execution import run_eval_execution
from .experiment_run import run_experiment_run
from .prompt_compile import run_prompt_compile

__all__ = [
    "run_experiment_run",
    "run_dataset_run",
    "run_eval_execution",
    "run_prompt_compile",
]
