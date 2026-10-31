"""DEEPTRACE simulation engine.

``get_engine()`` returns a process-wide cached :class:`SimulationEngine` for a region
(built from ``app.networks.loader.load_network``); ``reset_engine()`` drops the cache
(used by tests and after the dataset is regenerated).

Modules: ``graph`` (NetworkX structures), ``power`` / ``water`` / ``telecom`` /
``transport`` (system models), ``cascade`` (dependency rounds), ``report`` (metrics,
severity index, step labels, summary), ``compare``, ``trace``, ``metrics``, ``engine``
(public facade) and ``cli``.
"""

from __future__ import annotations

import threading

from app.simulation.engine import ENGINE_VERSION, SimulationEngine, scenario_hash

_ENGINES: dict[str, SimulationEngine] = {}
_LOCK = threading.Lock()


def get_engine(region_id: str | None = None) -> SimulationEngine:
    from app.config import get_settings
    from app.networks.loader import load_network

    rid = region_id or get_settings().region_id
    with _LOCK:
        engine = _ENGINES.get(rid)
        if engine is None:
            engine = SimulationEngine(load_network(rid))
            _ENGINES[rid] = engine
        return engine


def reset_engine() -> None:
    from app.networks.loader import load_network

    with _LOCK:
        _ENGINES.clear()
    load_network.cache_clear()


__all__ = ["ENGINE_VERSION", "SimulationEngine", "get_engine", "reset_engine", "scenario_hash"]
