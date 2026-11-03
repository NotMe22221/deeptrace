"""Small shared types and helpers for the simulation engine.

System models (power, water, telecom, transport) return *internal* outcome records
(:class:`NodeOutcome`, :class:`EdgeOutcome`, :class:`FlowRec`) instead of the Pydantic
contract models: they are cheap to create, hashable and immutable, which lets the
cascade orchestrator memoise system evaluations safely across cascade rounds and across
the thousands of single-failure runs used for criticality ranking. The orchestrator
converts them into ``AffectedNode`` / ``InterruptedEdge`` / ``EdgeFlow`` at the end.
"""

from __future__ import annotations

from dataclasses import dataclass

EPS = 1e-6

# Ranking used to merge states coming from several sources (system model, dependency
# propagation, direct failure). Higher = worse. "restored" ranks above "operational" so
# that an informative state survives a merge with a nominal one.
STATE_RANK: dict[str, int] = {
    "operational": 0,
    "restored": 1,
    "delayed": 2,
    "on_backup": 2,
    "degraded": 3,
    "overloaded": 3,
    "closed": 5,
    "inaccessible": 5,
    "disconnected": 5,
    "isolated": 5,
    "de_energized": 5,
    "outage": 6,
    "failed": 7,
}

EDGE_STATE_RANK: dict[str, int] = {
    "operational": 0,
    "normally_open": 0,
    "activated": 1,
    "rerouted": 2,
    "overloaded": 3,
    "interrupted": 4,
    "isolated": 5,
    "failed": 6,
}

# States in which a node has lost its function / service.
LOSS_STATES = frozenset({"failed", "outage", "de_energized", "disconnected", "isolated", "inaccessible", "closed"})
MAJOR_STATES = LOSS_STATES
MINOR_STATES = frozenset({"degraded", "delayed", "on_backup", "overloaded"})


@dataclass(frozen=True)
class NodeOutcome:
    """Non-nominal state of one node as computed by a model.

    ``info`` marks informational entries whose node state stays ``operational`` (e.g. a
    telecom endpoint that was rerouted onto a backup path). ``dep`` names the dependency
    connection type that drove the state (e.g. ``"power_supply"`` for a pump without
    power); the orchestrator then prefixes the provider explanation to ``cause``.
    """

    state: str
    cause: str
    caused_by: tuple[str, ...] = ()
    service_level: float = 0.0
    info: bool = False
    dep: str | None = None


@dataclass(frozen=True)
class EdgeOutcome:
    state: str
    reason: str


@dataclass(frozen=True)
class FlowRec:
    direction: int
    flow: float
    utilization: float
    unit: str | None


def worse_node(a: NodeOutcome | None, b: NodeOutcome | None) -> NodeOutcome | None:
    """Return the more severe of two outcomes, folding the other's cause in."""
    if a is None:
        return b
    if b is None:
        return a
    ra, rb = STATE_RANK.get(a.state, 0), STATE_RANK.get(b.state, 0)
    if (ra, not a.info) >= (rb, not b.info):
        first, second = a, b
    else:
        first, second = b, a
    if second.cause and second.cause not in first.cause and (second.state != "operational" or second.info):
        cause = f"{first.cause} Also: {second.cause}"
    else:
        cause = first.cause
    caused_by = tuple(dict.fromkeys(first.caused_by + second.caused_by))
    return NodeOutcome(
        state=first.state,
        cause=cause,
        caused_by=caused_by,
        service_level=min(first.service_level, second.service_level),
        info=first.info and second.info,
        dep=first.dep or second.dep,
    )


def worse_edge(a: EdgeOutcome | None, b: EdgeOutcome | None) -> EdgeOutcome | None:
    if a is None:
        return b
    if b is None:
        return a
    return a if EDGE_STATE_RANK.get(a.state, 0) >= EDGE_STATE_RANK.get(b.state, 0) else b


def fmt_num(value: float, digits: int = 1) -> str:
    """Format a number compactly (no trailing ``.0`` noise for integers)."""
    if value == float("inf"):
        return "unlimited"
    text = f"{value:,.{digits}f}"
    return text


def join_names(items: list[str], limit: int = 4) -> str:
    """'A', 'A and B', 'A, B and C', 'A, B, C and 4 more'."""
    items = list(items)
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    if len(items) <= limit:
        return ", ".join(items[:-1]) + " and " + items[-1]
    return ", ".join(items[:limit]) + f" and {len(items) - limit} more"


def plural(n: int, singular: str, plural_form: str | None = None) -> str:
    return f"{n} {singular if n == 1 else (plural_form or singular + 's')}"
