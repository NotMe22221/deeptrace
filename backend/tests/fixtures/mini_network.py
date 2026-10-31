"""Hand-crafted mini network exercising every simulation behaviour.

Layout (ids are what the tests reference)::

  POWER   TS-1 (80 MW) ─TL-1─ DS-A ─FC-A1─ SW-A1 ─FC-A2─ NV-A1 ─FC-A3─ NV-A2 ─FC-A4─ NV-A3
               └─TL-2─ DS-B ─FC-B1*─ NV-B1 ─FC-B2─ NV-B2               (*hosted in UG-DB-1)
          TS-2 (40 MW) ─TL-3─ DS-B
               └─TL-4─ DS-C ─FC-C1─ NV-C1 ─FC-C2─ NV-C2
          ties: NV-A3 ─TIE-1A─ SW-T1(open, 6 MW, SCADA from TEL-FH-2, 3 h manual) ─TIE-1B─ NV-B2
                NV-C2 ─TIE-2A─ SW-T2(open, 10 MW) ─TIE-2B─ NV-B1
  WATER   SRC-1 ─WM-1─ J-1 ─WM-2─ V-1 ─WM-3─ J-2 ─DM-1─ SZ-L1 (low, 50 L/s)
                                            J-2 ─DM-2─ V-2 ─DM-3─ PS-1 (pump, power NV-C2) ─DM-4─ SZ-H1 (high, 40 L/s)
                                            TNK-1 (500 m³) ─DM-5─ SZ-H1
                       J-1 ─DM-6─ V-3 ─DM-7─ SZ-L2 (low, 20 L/s)
                       J-1 ─DM-10─ J-3 ─DM-9─ V-NC (normally closed) ─DM-8─ SZ-L1
  TELECOM IX-1 ─FL-1─ CO-1 ─FL-2*─ FH-1 ─FL-3─ AN-1 ─FL-6─ FH-2 ─FL-5─ DC-1 ─FL-8─ IX-1
                                   FH-1 ─FL-4─ AN-2 ;  FH-1 ─FL-7─ CS-1 (battery 2 h)
  TRANSPORT GW-N ─R-1─ I-1 ─R-2─ I-2 ─R-3─ GW-S ;  I-1 ─R-4─ I-3 ─R-5─ I-4 ─R-6─ I-2 ;  I-4 ─R-7─ GW-S
            rail ST-1 ─RL-1─ ST-2 ─RL-2─ ST-3
  UNDERGROUND UG-V-1 ─UG-DB-1 (hosts PWR-FC-B1, TEL-FL-2)─ UG-V-2 ─UG-DB-2 (hosts TEL-FL-6)─ UG-V-3
  FACILITIES  FAC-HOSP-1 (critical; power NV-A1 + NV-B1, 48 h generator; water SZ-L1, 12 h storage)
              FAC-GOV-1 (critical; power NV-A2, no backup; water SZ-H1, no storage)
              FAC-VEN-1 (power NV-C1)
"""

from __future__ import annotations

from typing import Any

from app.models.schemas import (
    CameraView,
    InfrastructureEdge,
    InfrastructureNetwork,
    InfrastructureNode,
    Provenance,
    RegionInfo,
)

PROV = Provenance(category="simulated", source="DEEPTRACE unit-test fixture", confidence=1.0)


def _n(
    nid: str,
    name: str,
    system: str,
    type_: str,
    lat: float,
    lon: float,
    *,
    capacity: float | None = None,
    unit: str | None = None,
    demand: float | None = None,
    critical: bool = False,
    **props: Any,
) -> InfrastructureNode:
    return InfrastructureNode(
        id=nid,
        name=name,
        system=system,  # type: ignore[arg-type]
        type=type_,
        latitude=lat,
        longitude=lon,
        provenance=PROV,
        capacity=capacity,
        capacity_unit=unit,
        demand=demand,
        critical=critical,
        properties=props,
    )


def _e(
    eid: str,
    s: str,
    t: str,
    system: str,
    ctype: str,
    *,
    capacity: float | None = None,
    unit: str | None = None,
    length: float = 500.0,
    status: str = "operational",
    corridor: str | None = None,
    **props: Any,
) -> InfrastructureEdge:
    return InfrastructureEdge(
        id=eid,
        source_node=s,
        target_node=t,
        infrastructure_type=system,  # type: ignore[arg-type]
        connection_type=ctype,
        relation="physical",  # type: ignore[arg-type]
        capacity=capacity,
        capacity_unit=unit,
        length_m=length,
        status=status,  # type: ignore[arg-type]
        corridor_id=corridor,
        provenance=PROV,
        properties=props,
    )


def _d(eid: str, provider: str, consumer: str, ctype: str, system: str) -> InfrastructureEdge:
    return InfrastructureEdge(
        id=eid,
        source_node=provider,
        target_node=consumer,
        infrastructure_type=system,  # type: ignore[arg-type]
        connection_type=ctype,
        relation="dependency",  # type: ignore[arg-type]
        directed=True,
        provenance=PROV,
    )


def build_mini_network() -> InfrastructureNetwork:
    nodes = [
        # ---------------------------------------------------------------- power
        _n("PWR-TS-1", "TS North", "power", "transmission_substation", 33.770, -84.390, capacity=80, unit="MW"),
        _n("PWR-TS-2", "TS South", "power", "transmission_substation", 33.740, -84.390, capacity=40, unit="MW"),
        _n("PWR-DS-A", "DS Alpha", "power", "distribution_substation", 33.765, -84.395, capacity=20, unit="MW"),
        _n("PWR-DS-B", "DS Bravo", "power", "distribution_substation", 33.760, -84.385, capacity=20, unit="MW"),
        _n("PWR-DS-C", "DS Charlie", "power", "distribution_substation", 33.745, -84.385, capacity=20, unit="MW"),
        _n("PWR-SW-A1", "Sectionaliser A1", "power", "switch", 33.763, -84.396),
        _n(
            "PWR-NV-A1",
            "Vault A1",
            "power",
            "network_vault",
            33.761,
            -84.397,
            demand=3,
            unit="MW",
            population_served=1500,
        ),
        _n(
            "PWR-NV-A2",
            "Vault A2",
            "power",
            "network_vault",
            33.759,
            -84.397,
            demand=4,
            unit="MW",
            population_served=2000,
        ),
        _n(
            "PWR-NV-A3",
            "Vault A3",
            "power",
            "network_vault",
            33.757,
            -84.397,
            demand=2,
            unit="MW",
            population_served=800,
        ),
        _n(
            "PWR-NV-B1",
            "Vault B1",
            "power",
            "network_vault",
            33.758,
            -84.384,
            demand=3,
            unit="MW",
            population_served=1200,
        ),
        _n(
            "PWR-NV-B2",
            "Vault B2",
            "power",
            "network_vault",
            33.756,
            -84.384,
            demand=3,
            unit="MW",
            population_served=1000,
        ),
        _n(
            "PWR-NV-C1",
            "Vault C1",
            "power",
            "network_vault",
            33.744,
            -84.384,
            demand=2,
            unit="MW",
            population_served=900,
        ),
        _n(
            "PWR-NV-C2",
            "Vault C2",
            "power",
            "network_vault",
            33.742,
            -84.384,
            demand=4,
            unit="MW",
            population_served=1600,
        ),
        _n("PWR-SW-T1", "Tie switch T1", "power", "switch", 33.756, -84.390, normally_open=True, manual_switch_hours=3),
        _n("PWR-SW-T2", "Tie switch T2", "power", "switch", 33.750, -84.384, normally_open=True, manual_switch_hours=2),
        # ---------------------------------------------------------------- water
        _n("WTR-SRC-1", "Hemphill main entry", "water", "supply_source", 33.775, -84.380, capacity=200, unit="L/s"),
        _n("WTR-J-1", "Junction 1", "water", "junction", 33.770, -84.380),
        _n("WTR-V-1", "Valve 1", "water", "valve", 33.768, -84.380),
        _n("WTR-J-2", "Junction 2", "water", "junction", 33.766, -84.380),
        _n(
            "WTR-SZ-L1",
            "Zone Low 1",
            "water",
            "service_zone",
            33.764,
            -84.378,
            demand=50,
            unit="L/s",
            population=5000,
            pressure_zone="low",
        ),
        _n("WTR-V-2", "Valve 2", "water", "valve", 33.764, -84.381),
        _n("WTR-PS-1", "Booster PS-1", "water", "pump_station", 33.762, -84.381, capacity=80, unit="L/s"),
        _n(
            "WTR-SZ-H1",
            "Zone High 1",
            "water",
            "service_zone",
            33.760,
            -84.381,
            demand=40,
            unit="L/s",
            population=3000,
            pressure_zone="high",
        ),
        _n("WTR-TNK-1", "Elevated tank 1", "water", "storage_tank", 33.759, -84.383, storage_m3=500),
        _n("WTR-V-3", "Valve 3", "water", "valve", 33.770, -84.377),
        _n(
            "WTR-SZ-L2",
            "Zone Low 2",
            "water",
            "service_zone",
            33.769,
            -84.375,
            demand=20,
            unit="L/s",
            population=2000,
            pressure_zone="low",
        ),
        _n("WTR-J-3", "Junction 3", "water", "junction", 33.768, -84.376),
        _n("WTR-V-NC", "Boundary valve NC", "water", "valve", 33.766, -84.376, normally_closed=True),
        # -------------------------------------------------------------- telecom
        _n("TEL-IX-1", "Carrier hotel", "telecom", "internet_exchange", 33.758, -84.388),
        _n("TEL-DC-1", "Data centre", "telecom", "data_center", 33.752, -84.388, backup_hours=24),
        _n("TEL-CO-1", "Central office", "telecom", "central_office", 33.760, -84.392, backup_hours=8),
        _n("TEL-FH-1", "Fibre hub 1", "telecom", "fiber_hub", 33.760, -84.394),
        _n("TEL-FH-2", "Fibre hub 2", "telecom", "fiber_hub", 33.754, -84.390),
        _n(
            "TEL-AN-1",
            "Access node 1",
            "telecom",
            "access_node",
            33.757,
            -84.393,
            demand=2,
            unit="Gbps",
            population_served=2000,
        ),
        _n(
            "TEL-AN-2",
            "Access node 2",
            "telecom",
            "access_node",
            33.761,
            -84.395,
            demand=1,
            unit="Gbps",
            population_served=800,
        ),
        _n(
            "TEL-CS-1",
            "Cell site 1",
            "telecom",
            "cell_site",
            33.762,
            -84.396,
            demand=0.5,
            unit="Gbps",
            backup_hours=2,
            population_served=1500,
        ),
        # ------------------------------------------------------------ transport
        _n("TRN-GW-N", "North gateway", "transport", "gateway", 33.772, -84.392),
        _n("TRN-GW-S", "South gateway", "transport", "gateway", 33.742, -84.392),
        _n("TRN-I-1", "1st & Main", "transport", "intersection", 33.765, -84.392, signalized=True),
        _n("TRN-I-2", "2nd & Main", "transport", "intersection", 33.755, -84.392, signalized=True),
        _n("TRN-I-3", "1st & Side", "transport", "intersection", 33.765, -84.386, signalized=False),
        _n("TRN-I-4", "2nd & Side", "transport", "intersection", 33.755, -84.386, signalized=True, backup_hours=6),
        _n("TRN-ST-1", "Station North", "transport", "transit_station", 33.765, -84.380),
        _n("TRN-ST-2", "Station Centre", "transport", "transit_station", 33.755, -84.380),
        _n("TRN-ST-3", "Station South", "transport", "transit_station", 33.745, -84.380),
        # ---------------------------------------------------------- underground
        _n("UG-V-1", "Utility vault 1", "underground", "utility_vault", 33.761, -84.386),
        _n("UG-V-2", "Utility vault 2", "underground", "utility_vault", 33.761, -84.390),
        _n("UG-V-3", "Utility vault 3", "underground", "utility_vault", 33.757, -84.391),
        # ----------------------------------------------------------- facilities
        _n(
            "FAC-HOSP-1",
            "General Hospital",
            "facility",
            "hospital",
            33.754,
            -84.393,
            critical=True,
            backup_power_hours=48,
            water_storage_hours=12,
            occupancy=800,
        ),
        _n(
            "FAC-GOV-1",
            "City Hall",
            "facility",
            "government",
            33.766,
            -84.387,
            critical=True,
            backup_power_hours=0,
            water_storage_hours=0,
            occupancy=300,
        ),
        _n("FAC-VEN-1", "Arena", "facility", "venue", 33.754, -84.386, occupancy=5000),
    ]
    edges = [
        # ---------------------------------------------------------------- power
        _e("PWR-TL-1", "PWR-TS-1", "PWR-DS-A", "power", "transmission_line", capacity=50, unit="MW"),
        _e("PWR-TL-2", "PWR-TS-1", "PWR-DS-B", "power", "transmission_line", capacity=50, unit="MW"),
        _e("PWR-TL-3", "PWR-TS-2", "PWR-DS-B", "power", "transmission_line", capacity=50, unit="MW"),
        _e("PWR-TL-4", "PWR-TS-2", "PWR-DS-C", "power", "transmission_line", capacity=50, unit="MW"),
        _e("PWR-FC-A1", "PWR-DS-A", "PWR-SW-A1", "power", "feeder_cable", capacity=15, unit="MW", feeder_id="FDR-A"),
        _e("PWR-FC-A2", "PWR-SW-A1", "PWR-NV-A1", "power", "feeder_cable", capacity=15, unit="MW", feeder_id="FDR-A"),
        _e("PWR-FC-A3", "PWR-NV-A1", "PWR-NV-A2", "power", "feeder_cable", capacity=15, unit="MW", feeder_id="FDR-A"),
        _e("PWR-FC-A4", "PWR-NV-A2", "PWR-NV-A3", "power", "feeder_cable", capacity=15, unit="MW", feeder_id="FDR-A"),
        _e(
            "PWR-FC-B1",
            "PWR-DS-B",
            "PWR-NV-B1",
            "power",
            "feeder_cable",
            capacity=15,
            unit="MW",
            corridor="UG-DB-1",
            feeder_id="FDR-B",
        ),
        _e("PWR-FC-B2", "PWR-NV-B1", "PWR-NV-B2", "power", "feeder_cable", capacity=15, unit="MW", feeder_id="FDR-B"),
        _e("PWR-FC-C1", "PWR-DS-C", "PWR-NV-C1", "power", "feeder_cable", capacity=15, unit="MW", feeder_id="FDR-C"),
        _e("PWR-FC-C2", "PWR-NV-C1", "PWR-NV-C2", "power", "feeder_cable", capacity=15, unit="MW", feeder_id="FDR-C"),
        _e("PWR-TIE-1A", "PWR-NV-A3", "PWR-SW-T1", "power", "tie_line", capacity=6, unit="MW", status="normally_open"),
        _e("PWR-TIE-1B", "PWR-SW-T1", "PWR-NV-B2", "power", "tie_line", capacity=6, unit="MW", status="normally_open"),
        _e("PWR-TIE-2A", "PWR-NV-C2", "PWR-SW-T2", "power", "tie_line", capacity=10, unit="MW", status="normally_open"),
        _e("PWR-TIE-2B", "PWR-SW-T2", "PWR-NV-B1", "power", "tie_line", capacity=10, unit="MW", status="normally_open"),
        # ---------------------------------------------------------------- water
        _e("WTR-WM-1", "WTR-SRC-1", "WTR-J-1", "water", "water_main", capacity=300, unit="L/s"),
        _e("WTR-WM-2", "WTR-J-1", "WTR-V-1", "water", "water_main", capacity=150, unit="L/s"),
        _e("WTR-WM-3", "WTR-V-1", "WTR-J-2", "water", "water_main", capacity=150, unit="L/s"),
        _e("WTR-DM-1", "WTR-J-2", "WTR-SZ-L1", "water", "distribution_main", capacity=100, unit="L/s"),
        _e("WTR-DM-2", "WTR-J-2", "WTR-V-2", "water", "distribution_main", capacity=100, unit="L/s"),
        _e("WTR-DM-3", "WTR-V-2", "WTR-PS-1", "water", "distribution_main", capacity=100, unit="L/s"),
        _e("WTR-DM-4", "WTR-PS-1", "WTR-SZ-H1", "water", "distribution_main", capacity=100, unit="L/s"),
        _e("WTR-DM-5", "WTR-TNK-1", "WTR-SZ-H1", "water", "distribution_main", capacity=100, unit="L/s"),
        _e("WTR-DM-6", "WTR-J-1", "WTR-V-3", "water", "distribution_main", capacity=100, unit="L/s"),
        _e("WTR-DM-7", "WTR-V-3", "WTR-SZ-L2", "water", "distribution_main", capacity=100, unit="L/s"),
        _e("WTR-DM-10", "WTR-J-1", "WTR-J-3", "water", "distribution_main", capacity=100, unit="L/s"),
        _e("WTR-DM-9", "WTR-J-3", "WTR-V-NC", "water", "distribution_main", capacity=100, unit="L/s"),
        _e("WTR-DM-8", "WTR-V-NC", "WTR-SZ-L1", "water", "distribution_main", capacity=100, unit="L/s"),
        # -------------------------------------------------------------- telecom
        _e("TEL-FL-1", "TEL-IX-1", "TEL-CO-1", "telecom", "fiber_link", capacity=10, unit="Gbps", length=1000),
        _e(
            "TEL-FL-2",
            "TEL-CO-1",
            "TEL-FH-1",
            "telecom",
            "fiber_link",
            capacity=10,
            unit="Gbps",
            length=800,
            corridor="UG-DB-1",
        ),
        _e("TEL-FL-3", "TEL-FH-1", "TEL-AN-1", "telecom", "fiber_link", capacity=10, unit="Gbps", length=300),
        _e("TEL-FL-4", "TEL-FH-1", "TEL-AN-2", "telecom", "fiber_link", capacity=10, unit="Gbps", length=400),
        _e("TEL-FL-5", "TEL-DC-1", "TEL-FH-2", "telecom", "fiber_link", capacity=10, unit="Gbps", length=900),
        _e(
            "TEL-FL-6",
            "TEL-FH-2",
            "TEL-AN-1",
            "telecom",
            "fiber_link",
            capacity=10,
            unit="Gbps",
            length=1500,
            corridor="UG-DB-2",
        ),
        _e("TEL-FL-7", "TEL-FH-1", "TEL-CS-1", "telecom", "fiber_link", capacity=10, unit="Gbps", length=500),
        _e("TEL-FL-8", "TEL-IX-1", "TEL-DC-1", "telecom", "fiber_link", capacity=10, unit="Gbps", length=2000),
        # ------------------------------------------------------------ transport
        _e("TRN-R-1", "TRN-GW-N", "TRN-I-1", "transport", "road_segment", capacity=1800, travel_time_s=60),
        _e("TRN-R-2", "TRN-I-1", "TRN-I-2", "transport", "road_segment", capacity=1800, travel_time_s=60),
        _e("TRN-R-3", "TRN-I-2", "TRN-GW-S", "transport", "road_segment", capacity=1800, travel_time_s=60),
        _e("TRN-R-4", "TRN-I-1", "TRN-I-3", "transport", "road_segment", capacity=1800, travel_time_s=40),
        _e("TRN-R-5", "TRN-I-3", "TRN-I-4", "transport", "road_segment", capacity=1800, travel_time_s=90),
        _e("TRN-R-6", "TRN-I-4", "TRN-I-2", "transport", "road_segment", capacity=1800, travel_time_s=40),
        _e("TRN-R-7", "TRN-I-4", "TRN-GW-S", "transport", "road_segment", capacity=1800, travel_time_s=100),
        _e("TRN-RL-1", "TRN-ST-1", "TRN-ST-2", "transport", "rail_segment"),
        _e("TRN-RL-2", "TRN-ST-2", "TRN-ST-3", "transport", "rail_segment"),
        # ---------------------------------------------------------- underground
        _e(
            "UG-DB-1",
            "UG-V-1",
            "UG-V-2",
            "underground",
            "duct_bank",
            length=400,
            hosted_edge_ids=["PWR-FC-B1", "TEL-FL-2"],
        ),
        _e("UG-DB-2", "UG-V-2", "UG-V-3", "underground", "duct_bank", length=400, hosted_edge_ids=["TEL-FL-6"]),
        # ---------------------------------------------------------- dependencies
        _d("DEP-PS1-PWR", "PWR-NV-C2", "WTR-PS-1", "power_supply", "power"),
        _d("DEP-DC1-PWR", "PWR-NV-B1", "TEL-DC-1", "power_supply", "power"),
        _d("DEP-CO1-PWR", "PWR-NV-A1", "TEL-CO-1", "power_supply", "power"),
        _d("DEP-FH1-PWR", "PWR-NV-A2", "TEL-FH-1", "power_supply", "power"),
        _d("DEP-CS1-PWR", "PWR-NV-A3", "TEL-CS-1", "power_supply", "power"),
        _d("DEP-I1-PWR", "PWR-NV-B1", "TRN-I-1", "power_supply", "power"),
        _d("DEP-I2-PWR", "PWR-NV-A1", "TRN-I-2", "power_supply", "power"),
        _d("DEP-I4-PWR", "PWR-NV-C1", "TRN-I-4", "power_supply", "power"),
        _d("DEP-ST1-PWR", "PWR-NV-A2", "TRN-ST-1", "power_supply", "power"),
        _d("DEP-ST2-PWR", "PWR-NV-B2", "TRN-ST-2", "power_supply", "power"),
        _d("DEP-T1-SCADA", "TEL-FH-2", "PWR-SW-T1", "control_link", "telecom"),
        _d("DEP-HOSP-PWR-A", "PWR-NV-A1", "FAC-HOSP-1", "power_supply", "power"),
        _d("DEP-HOSP-PWR-B", "PWR-NV-B1", "FAC-HOSP-1", "power_supply", "power"),
        _d("DEP-HOSP-WTR", "WTR-SZ-L1", "FAC-HOSP-1", "water_supply", "water"),
        _d("DEP-HOSP-TEL", "TEL-AN-1", "FAC-HOSP-1", "telecom_link", "telecom"),
        _d("DEP-HOSP-ROAD", "TRN-I-2", "FAC-HOSP-1", "road_access", "transport"),
        _d("DEP-GOV-PWR", "PWR-NV-A2", "FAC-GOV-1", "power_supply", "power"),
        _d("DEP-GOV-WTR", "WTR-SZ-H1", "FAC-GOV-1", "water_supply", "water"),
        _d("DEP-GOV-TEL", "TEL-AN-2", "FAC-GOV-1", "telecom_link", "telecom"),
        _d("DEP-GOV-ROAD", "TRN-I-3", "FAC-GOV-1", "road_access", "transport"),
        _d("DEP-VEN-PWR", "PWR-NV-C1", "FAC-VEN-1", "power_supply", "power"),
        _d("DEP-VEN-ROAD", "TRN-I-4", "FAC-VEN-1", "road_access", "transport"),
        _d("DEP-ST1-ROAD", "TRN-I-3", "TRN-ST-1", "road_access", "transport"),
        _d("DEP-ST2-ROAD", "TRN-I-4", "TRN-ST-2", "road_access", "transport"),
        _d("DEP-ST3-ROAD", "TRN-GW-S", "TRN-ST-3", "road_access", "transport"),
    ]
    region = RegionInfo(
        id="mini",
        name="Mini test district",
        city="Testville",
        bbox=(33.735, -84.400, 33.780, -84.370),
        center=(33.757, -84.387),
        default_camera=CameraView(longitude=-84.387, latitude=33.757, height=2000),
        ground_elevation_m=300,
    )
    return InfrastructureNetwork(
        id="mini-network",
        name="Mini test network",
        version="test",
        generated_at="2026-01-01T00:00:00Z",
        region=region,
        nodes=nodes,
        edges=edges,
    )


def node(net: InfrastructureNetwork, nid: str) -> InfrastructureNode:
    """Mutable handle on a fixture node (tests tweak capacities before building an engine)."""
    return next(n for n in net.nodes if n.id == nid)


def edge(net: InfrastructureNetwork, eid: str) -> InfrastructureEdge:
    return next(e for e in net.edges if e.id == eid)
