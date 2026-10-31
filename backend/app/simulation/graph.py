"""NetworkX structures built once per network and shared by every simulation module.

* ``physical[system]``  – undirected ``nx.MultiGraph`` of the system's physical edges
  (edge ids are the multigraph keys, so parallel cables/pipes survive).
* ``dependency``        – ``nx.MultiDiGraph`` provider -> consumer of all dependency edges.
* ``providers`` / ``consumers`` – dependency adjacency as :class:`DepLink` lists.
* ``corridor_hosted``   – underground corridor edge -> edges it hosts (``hosted_edge_ids``
  on the corridor plus every edge whose ``corridor_id`` names it).
* ``vault_hosted``      – utility vault -> edges routed through it (hosted by an incident
  corridor segment, plus an optional ``hosted_edge_ids`` property on the vault).
* ``combined``          – all physical edges plus dependency links (as zero-system
  connectors) for cross-system path finding.

The class also collects ``warnings`` about contract violations found while building
(dangling edges, unknown hosted edge ids, ...); they are surfaced by the CLI and the
test-suite and never abort the engine.
"""

from __future__ import annotations

import math
from typing import Any, NamedTuple

import networkx as nx

from app.models.schemas import InfrastructureEdge, InfrastructureNetwork, InfrastructureNode

SYSTEMS: tuple[str, ...] = ("power", "water", "telecom", "transport", "underground", "facility")
INF = float("inf")


class DepLink(NamedTuple):
    edge_id: str
    provider: str
    consumer: str
    ctype: str


def sval(value: Any) -> str:
    """Enum or str -> str."""
    return value.value if hasattr(value, "value") else str(value)


def as_float(value: Any, default: float | None = None) -> float | None:
    """Robust float conversion (None / NaN / garbage -> default)."""
    if value is None or isinstance(value, bool):
        return default
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(f):
        return default
    return f


def as_bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"true", "yes", "1", "y"}
    return bool(value)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


class NetworkGraphs:
    """Indexed, immutable view of an :class:`InfrastructureNetwork`."""

    def __init__(self, network: InfrastructureNetwork) -> None:
        self.network = network
        self.warnings: list[str] = []
        self.nodes: dict[str, InfrastructureNode] = {n.id: n for n in network.nodes}
        self.edges: dict[str, InfrastructureEdge] = {e.id: e for e in network.edges}
        if len(self.nodes) != len(network.nodes):
            self.warnings.append("duplicate node ids in network (later definitions win)")
        if len(self.edges) != len(network.edges):
            self.warnings.append("duplicate edge ids in network (later definitions win)")
        self.node_ids: list[str] = sorted(self.nodes)
        self.edge_ids: list[str] = sorted(self.edges)

        self.node_sys: dict[str, str] = {nid: sval(n.system) for nid, n in self.nodes.items()}
        self.node_type: dict[str, str] = {nid: n.type for nid, n in self.nodes.items()}
        self.edge_sys: dict[str, str] = {eid: sval(e.infrastructure_type) for eid, e in self.edges.items()}

        self.nodes_by_system: dict[str, list[str]] = {s: [] for s in SYSTEMS}
        for nid in self.node_ids:
            self.nodes_by_system.setdefault(self.node_sys[nid], []).append(nid)
        self.nodes_by_type: dict[str, list[str]] = {}
        for nid in self.node_ids:
            self.nodes_by_type.setdefault(self.node_type[nid], []).append(nid)

        # ---------------------------------------------------------------- edges
        self.physical: dict[str, nx.MultiGraph] = {s: nx.MultiGraph() for s in SYSTEMS}
        for s in SYSTEMS:
            self.physical[s].add_nodes_from(self.nodes_by_system.get(s, []))
        self.physical_edges_by_system: dict[str, list[str]] = {s: [] for s in SYSTEMS}
        self.dependency_edge_ids: list[str] = []
        self.dependency = nx.MultiDiGraph()
        self.dependency.add_nodes_from(self.node_ids)
        self.providers: dict[str, list[DepLink]] = {}
        self.consumers: dict[str, list[DepLink]] = {}
        self.incident: dict[str, list[str]] = {nid: [] for nid in self.node_ids}
        self.dep_links: dict[str, DepLink] = {}
        self.combined = nx.MultiGraph()
        self.combined.add_nodes_from(self.node_ids)

        for eid in self.edge_ids:
            e = self.edges[eid]
            u, v = e.source_node, e.target_node
            if u not in self.nodes or v not in self.nodes:
                self.warnings.append(f"edge {eid} references unknown node(s) {u!r}/{v!r}; ignored")
                continue
            self.incident[u].append(eid)
            if v != u:
                self.incident[v].append(eid)
            if sval(e.relation) == "dependency":
                link = DepLink(eid, u, v, e.connection_type)
                self.dependency_edge_ids.append(eid)
                self.dependency.add_edge(u, v, key=eid, ctype=e.connection_type)
                self.providers.setdefault(v, []).append(link)
                self.consumers.setdefault(u, []).append(link)
                self.dep_links[eid] = link
                self.combined.add_edge(u, v, key=eid, weight=self._geo_len(u, v), dependency=True)
            else:
                sys_ = self.edge_sys[eid]
                self.physical_edges_by_system.setdefault(sys_, []).append(eid)
                self.physical.setdefault(sys_, nx.MultiGraph()).add_edge(u, v, key=eid)
                self.combined.add_edge(u, v, key=eid, weight=self.edge_length(eid), dependency=False)

        # ------------------------------------------------------------ corridors
        self.corridor_edges: list[str] = [
            eid
            for eid in self.physical_edges_by_system.get("underground", [])
            if self.edges[eid].connection_type in {"duct_bank", "utility_tunnel"}
        ]
        hosted: dict[str, set[str]] = {c: set() for c in self.corridor_edges}
        for c in self.corridor_edges:
            for hid in self.edges[c].properties.get("hosted_edge_ids") or []:
                if hid in self.edges:
                    hosted[c].add(hid)
                else:
                    self.warnings.append(f"corridor {c} hosts unknown edge {hid!r}")
        for eid in self.edge_ids:
            cid = self.edges[eid].corridor_id
            if cid:
                if cid in hosted:
                    hosted[cid].add(eid)
                else:
                    self.warnings.append(f"edge {eid} has corridor_id {cid!r} that is not a duct_bank/utility_tunnel edge")
        self.corridor_hosted: dict[str, list[str]] = {c: sorted(h) for c, h in hosted.items()}
        self.hosted_by: dict[str, list[str]] = {}
        for c, hs in self.corridor_hosted.items():
            for h in hs:
                self.hosted_by.setdefault(h, []).append(c)
        self.vault_hosted: dict[str, list[str]] = {}
        for vid in self.nodes_by_type.get("utility_vault", []):
            hs: set[str] = set()
            for eid in self.incident[vid]:
                if eid in hosted:
                    hs |= hosted[eid]
            for hid in self.nodes[vid].properties.get("hosted_edge_ids") or []:
                if hid in self.edges:
                    hs.add(hid)
            self.vault_hosted[vid] = sorted(hs)

    # ------------------------------------------------------------------ helpers
    def _geo_len(self, u: str, v: str) -> float:
        a, b = self.nodes[u], self.nodes[v]
        return haversine_m(a.latitude, a.longitude, b.latitude, b.longitude)

    def edge_length(self, eid: str) -> float:
        e = self.edges[eid]
        if e.length_m and e.length_m > 0:
            return float(e.length_m)
        return max(1.0, self._geo_len(e.source_node, e.target_node))

    def name(self, item_id: str) -> str:
        if item_id in self.nodes:
            return self.nodes[item_id].name or item_id
        if item_id in self.edges:
            return self.edges[item_id].name or item_id
        return item_id

    def label(self, item_id: str) -> str:
        """``ID (Name)`` – the canonical way elements are referenced in explanations."""
        nm = self.name(item_id)
        return item_id if not nm or nm == item_id else f"{item_id} ({nm})"

    def nprop(self, nid: str, *keys: str, default: Any = None) -> Any:
        props = self.nodes[nid].properties
        for k in keys:
            if k in props and props[k] is not None:
                return props[k]
        return default

    def eprop(self, eid: str, *keys: str, default: Any = None) -> Any:
        props = self.edges[eid].properties
        for k in keys:
            if k in props and props[k] is not None:
                return props[k]
        return default

    def other_end(self, eid: str, nid: str) -> str:
        e = self.edges[eid]
        return e.target_node if e.source_node == nid else e.source_node

    def is_critical_facility(self, nid: str) -> bool:
        return self.node_sys.get(nid) == "facility" and bool(self.nodes[nid].critical)

    def power_backup_hours(self, nid: str) -> float:
        return as_float(self.nprop(nid, "backup_power_hours", "backup_hours"), 0.0) or 0.0

    def water_backup_hours(self, nid: str) -> float:
        return as_float(self.nprop(nid, "water_storage_hours"), 0.0) or 0.0

    def population(self, nid: str) -> float:
        """Residents/occupants associated with a service node (0 if unknown)."""
        v = self.nprop(nid, "population_served", "population", "occupancy", default=0)
        return max(0.0, as_float(v, 0.0) or 0.0)
