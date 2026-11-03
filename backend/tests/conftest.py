"""Shared pytest fixtures."""

from __future__ import annotations

import pytest

from tests.fixtures.mini_network import build_mini_network


@pytest.fixture
def mini_network():
    """A fresh hand-crafted network (tests may mutate it before building an engine)."""
    return build_mini_network()


@pytest.fixture
def mini_engine(mini_network):
    from app.simulation import SimulationEngine

    return SimulationEngine(mini_network)
