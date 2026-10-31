# DEEPTRACE

**See the systems that make our world work.**

DEEPTRACE is an interactive 3D infrastructure-intelligence platform. It places a city's
water, electricity, internet and transportation networks, the shared underground
corridors they run through, and the critical facilities that depend on them into one
explorable geographic environment. Users can reveal what lies beneath the streets, trace
how components connect and depend on each other, fail any component, and watch a
deterministic network simulation propagate the cascade through the 3D world. An AI
analyst explains outcomes by calling the same simulation tools and can quantify
mitigations.

> **Honesty first.** Real underground utility records are not public. This build ships an
> **illustrative** infrastructure network placed in downtown Atlanta. Every element
> carries a visible provenance label (VERIFIED, PUBLICLY MAPPED, ESTIMATED or SIMULATED),
> and the simulation is a simplified, explainable model, not a validated engineering
> prediction.

**At a glance (Atlanta demo region):**

- **Network:** 350 nodes and 649 connections across power, water, internet, transport, underground corridors and 12 critical facilities, with 204 cross-system dependencies.
- **Scenarios:** 6 deterministic preset scenarios, including a genuine overload-trip cascade.
- **Engine speed:** a typical scenario simulates in 2–20 ms, and the full N-1 criticality ranking takes about 2 s.

---

## 1. The problem

Cities run on interdependent systems that are almost invisible: pipes, cables, fibre,
vaults and duct banks under the streets, connected by dependencies nobody draws on a
single map. A substation outage stops a booster pump, which drops water pressure in a
hospital district. One excavation strike can cut power and fibre that share a trench.
These relationships are spread across separate GIS layers, engineering diagrams and
institutional knowledge, so they are hard to reason about, explain or plan for.

## 2. The product

| Capability | What it does |
|---|---|
| **World View** | Full-screen CesiumJS globe streaming **Cesium OSM Buildings** and **Cesium World Terrain** for downtown Atlanta (configurable region) with a cinematic dark command-centre look. |
| **Infrastructure Explorer** | Toggle Water, Electricity, Internet, Transportation, Underground utilities and Critical facilities. Each system has its own colour and rendering style, and several can be shown at once. |
| **Deep Mode (X-ray city)** | Buildings fade to x-ray silhouettes, the ground turns translucent, networks drop to their (exaggerated) depths between labelled strata, and the camera moves to an underground vantage. A depth-exaggeration slider changes the depth scale live. |
| **Living Networks** | GPU-batched flow particles move along every connection in its modelled flow direction: cyan water, amber power pulses, violet data packets and emerald traffic. Failures stop the flow, and rerouted paths light up. |
| **Component Inspector** | Name, type, coordinates, provenance (source and confidence), capacity, connections, upstream and downstream elements, cross-system dependencies, N-1 criticality and current simulation state with its cause chain. |
| **Connection Trace** | Upstream supply paths, downstream service and dependents. **Physical connections** (solid glowing lines) are kept visually distinct from **logical dependencies** (dashed arcs). |
| **Cascade Mode** | A deterministic NetworkX simulation with a separate model for each system (power, water, telecom, transport and shared corridors) plus cross-system dependency propagation, animated step by step in 3D. |
| **Simulation Center** | Presets for power failure, water main rupture, internet exchange outage, road disruption and utility-corridor strike, plus custom scenarios, an outage horizon, automatic restoration and a cascade timeline. |
| **Scenario Comparison** | Compares scenario A and B on transparent metrics, shows the verdict and maps the difference (only A, only B, both) directly in the world. |
| **AI Infrastructure Analyst** | Claude with strictly controlled tools (`run_failure_simulation`, `trace_network_path`, `evaluate_mitigation`…). Its tool calls drive the 3D view. Without an API key, a deterministic offline analyst answers using the same tools and says so. |
| **Demo Mode** | A reproducible 10-step judge walkthrough with **Reset demo** and one-click **Restore world**, which also runs from a precomputed engine snapshot if the backend is down. |

## 3. Architecture

```
 Browser (Next.js 16 · React 19 · TypeScript · Tailwind 4 · zustand · framer-motion)
 ┌───────────────────────────────────────────────────────────────────────────────┐
 │ components/interface/*   panels, inspector, simulation center, AI chat, demo  │
 │            │  zustand store (src/lib/store.ts) — single coordination point    │
 │            ▼                                                                   │
 │ engine/*  WorldController → CesiumJS (runtime-loaded from /public/cesium)      │
 │   buildings (OSM Buildings + x-ray/blackout CustomShader) · terrain sampling   │
 │   network primitives · flow particles · deep-mode strata · cascade playback    │
 └───────────────▲───────────────────────────────────────┬───────────────────────┘
                 │ REST + SSE (analyst stream)           │ 3D Tiles / terrain / imagery
 ┌───────────────┴──────────────────────────────┐   ┌────▼──────────────────────────┐
 │ FastAPI backend (Python 3.13)                │   │ Cesium ion (runtime, token)   │
 │  api/routes.py    REST + Server-Sent Events  │   │ OSM Buildings · World Terrain │
 │  simulation/*     NetworkX engine per system │   └───────────────────────────────┘
 │  ai/*             Claude tool loop + offline │
 │  networks/*       region data → network      │──▶ Anthropic Messages API (optional)
 │  ingest/*         Overpass → cache → OSM     │──▶ Overpass API (offline, cached)
 └──────────────────────────────────────────────┘
```

* **Single data contract**: `backend/app/models/schemas.py` (Pydantic) is the source of truth, mirrored field for field in `src/types/infrastructure.ts`.
* **Simulation drives the world**: every `SimulationResult` carries per-node/per-edge states, cascade steps and edge flows. The world renders the cascade progressively from them, so a new result, from the UI or from the AI, changes the city.
* **Graceful degradation**: no Cesium token → dark CARTO basemap, no buildings, everything else works. No backend → offline snapshot of genuine engine outputs (`public/demo/snapshot.json`). No LLM key → offline analyst.

```
src/
  app/                    layout, page, global design tokens
  components/world/       CityViewer, tooltip, world overlay
  components/interface/   toolbar, layers, inspector, simulation, analyst, comparison, provenance, demo
  engine/                 world controller, rendering systems, geographic helpers, world bridge
  lib/                    store, API client, system/state/provenance vocabulary
  types/                  data contract mirror
backend/
  app/main.py             FastAPI app
  app/api/                routes (REST + SSE)
  app/simulation/         engine, per-system models, cascade, compare, trace, metrics
  app/ai/                 tools, Claude loop, offline analyst
  app/networks/           loader, street graph, deterministic generator
  app/ingest/             Overpass ingestion + normalisation, Poly Haven asset fetcher
  app/scripts/            offline snapshot export
  datasets/regions/<id>/  region.json, streets.json, landmarks.json, network.json, scenarios.json, demo.json
  tests/                  pytest suite
public/demo/              network.json + snapshot.json (offline mode)
```

## 4. Data sources & provenance

| Layer | Source | Provenance in this build |
|---|---|---|
| 3D buildings | Cesium OSM Buildings (streamed 3D Tiles, © OpenStreetMap contributors, ODbL) | PUBLICLY MAPPED (rendered context only; not part of the network graph) |
| Terrain | Cesium World Terrain | Streamed at runtime |
| Street alignments | Authored approximations of the downtown grid | **ESTIMATED** (replaced by OSM roads via `make ingest`) |
| Named places (MARTA stations, Grady, City Hall, Capitol, venues, 56 Marietta St) | General public knowledge | **ESTIMATED** location, real identity |
| Utility assets & routes (substations, feeders, mains, pumps, fibre rings, duct banks) | Deterministic generator | **SIMULATED**: illustrative, not real utility records |
| All dependencies (power→pump, fibre→SCADA, water→hospital…) | Deterministic generator | **SIMULATED** |

The four categories are shown verbatim on every inspector, tooltip, provenance panel and AI
answer. **VERIFIED** is reserved for authoritative data that the pipeline has actually
inspected, and nothing in this build qualifies. The Provenance panel lists every dataset
with its license, retrieval date and whether it was inspected.

**Why no real utility geometry?** Underground utility locations are generally not public,
for security and safety reasons. In this build the container's network policy also blocked
Overpass, Cesium ion, Poly Haven and ArcGIS/Atlanta open-data hosts, so nothing was
fetched. The ingestion code is complete and cached (`make ingest`). Once run, roads and
any publicly mapped substations, water towers or telecom facilities become PUBLICLY
MAPPED, while the topology between them stays SIMULATED.

### Ingesting OpenStreetMap data

```bash
make ingest           # python -m app.ingest.overpass  → backend/datasets/cache/osm/<region>.json (cached; never fetched on app start)
                      # python -m app.networks.generate --use-osm
make snapshot         # refresh the offline snapshot
```

### Changing the region

Each region is one folder `backend/datasets/regions/<id>/`:

| File | Contents |
|---|---|
| `region.json` | id, name, city, bbox `(south, west, north, east)`, centre `(lat, lon)`, `default_camera`, `ground_elevation_m`, timezone |
| `streets.json` | authored street centrelines (`[lon, lat]` coords, class, lanes, oneway, speed) with per-feature provenance. Optional when building with `--use-osm` |
| `landmarks.json` | real named places (`kind`, `lat`/`lon`, an `osm_match` spec, provenance) and rail lines (station order, approximate alignment, depths) |
| `design.json` | the **simulated** infrastructure design: substations, lines (primary/alternate), feeders and ties; water sources, pump, tank, pipes with valves, zones; telecom cores, hubs, links, sites; corridors; facility profiles; dependency overrides; scenarios and the demo script. Anchors are written as street intersections (`"at": "Street A & Street B"`), so the same design works on OSM roads |

Then:

```bash
export DEEPTRACE_REGION=<id>                                  # or pass --region <id>
cd backend
.venv/bin/python -m app.ingest.overpass --region <id>         # optional: cache OSM (needs network access)
.venv/bin/python -m app.networks.generate --region <id> [--use-osm]   # writes network/scenarios/demo + public mirror; exits 1 if a sanity check fails
.venv/bin/python -m app.scripts.export_snapshot               # refresh the offline snapshot
```

`backend/app/networks/checks.py` validates any region (ids, geometry, provenance rules);
`backend/tests/test_dataset.py` contains Atlanta-specific expectations.

## 5. Simulation methodology

The engine (`backend/app/simulation/`) builds NetworkX graphs once per network: a
physical MultiGraph per system, a dependency DiGraph and a corridor→hosted-edge map. A
scenario fails nodes and/or edges and is assessed `horizon_hours` after onset.

**Electricity**: energisation is a breadth-first search from transmission supply points
over closed edges, with normally-open ties excluded. De-energised islands are restored
through normally-open tie switches when the tie rating and the supplying substation's
headroom allow. Otherwise restoration is partial, critical loads first. Tie switches
whose SCADA link is down can only be closed manually once `horizon ≥ manual_switch_hours`.
Loading above 100 % is flagged as overloaded, and above 120 % the element trips, which
starts the next cascade round. No AC power flow is computed.

**Water**: a pipe rupture closes the nearest isolation valves, isolating the whole valve
segment. Service is approximated by max-flow from supplies (and tank storage spread over
the horizon) through operating pumps to zone demands. High-pressure zones can only be
served through a running pump or the tank. Service ≥ 98 % counts as normal, ≥ 50 % as low
pressure and below that as an outage. Closed boundary valves are reported as alternative
paths with their recoverable flow.

**Internet**: connectivity to any operating core (internet exchange or data centre) runs
over working fibre. Demand is routed on shortest paths, and links above capacity are
overloaded. Sites without power run on batteries or generators until
`backup_hours < horizon`, then go dark.

**Transport**: shortest travel times from highway gateways to critical facilities and
stations are compared before and after the failure. Closed segments force detours, and an
unpowered signal turns its intersection into an all-way stop with added delay. Rail
stations without traction power close and interrupt adjacent rail segments.

**Underground corridors**: failing a duct bank or vault fails every cable and fibre it
hosts (common-cause failure).

**Cascade**: rounds alternate between system models and **dependency propagation**. When
a provider loses service, its consumer switches to backup if that backup covers the
horizon. Otherwise the consumer loses its function, for example a pump without power, and
its own system is re-evaluated in the next round. Rounds continue until nothing changes.
Every affected element records the round in which it was first affected, a severity, the
cause in plain language and the ids that caused it.

**Metrics**: the result reports unserved MW and L/s, disconnected endpoints, change in
travel time, closed stations, affected critical facilities, modelled population and a
**redundancy score**. The redundancy score is the share of initially cut demand that
meshing, tie switching, rerouting, storage or detours recover; demand of directly failed
elements counts as lost. The composite **severity index (0–100)** is:

```
severity = 100 × ( 0.20·√x_power + 0.15·√x_water + 0.15·√x_telecom
                 + 0.15·√x_transport + 0.25·√x_facilities + 0.10·√x_population )
```

| Term | Definition |
|---|---|
| `x_power` | unserved MW / baseline MW |
| `x_water` | unserved L/s / baseline L/s |
| `x_telecom` | (endpoints without service + 0.3 × congested endpoints) / endpoints |
| `x_transport` | min(1, travel-time increase / 100 + share of unreachable O-D pairs + 0.5 × share of closed stations) |
| `x_facilities` | Σ impact / critical facilities, where impact is 1 for outage or inaccessible, 0.5 for degraded and 0.25 for on backup or delayed |
| `x_population` | affected / modelled population |

Every share is clipped to [0, 1]. The square roots make the first losses count; the weights
sum to 1. The formula is in `backend/app/simulation/report.py` and is restated in every
result's `assumptions`. **N-1 criticality** fails every component on its own and ranks the
components by severity.

**Determinism**: there is no randomness. The scenario id is a hash of the scenario
inputs, and identical inputs give identical outputs, apart from the timestamp and
computation time.

## 6. AI Infrastructure Analyst

* **Claude** (`DEEPTRACE_LLM_MODEL`, default `claude-opus-5-5`) runs in a manual tool-use loop (`backend/app/ai/analyst.py`) with adaptive thinking, configurable effort, prompt caching and server-side refusal fallbacks. Text streams to the UI over Server-Sent Events.
* **Controlled tools** (`backend/app/ai/tools.py`): `search_components`, `get_component_details`, `get_connected_nodes`, `trace_network_path`, `run_failure_simulation`, `get_affected_components`, `compare_scenarios`, `get_network_metrics`, `get_data_provenance`, `evaluate_mitigation` (re-runs the scenario on a modified copy of the network), `highlight_components` and `focus_camera`. Every id is validated, and unknown ids return errors with close-match suggestions.
* **The world reacts to tool results, not to model prose**: UI actions (show simulation, trace, comparison, highlight, fly-to) are derived from tool outputs.
* **Guardrails**: the system prompt requires that every fact come from a tool, that simulated or estimated data never be presented as real, and that questions outside the loaded data be declined plainly.
* **Offline analyst** (`backend/app/ai/offline.py`): deterministic intent rules plus the same tools. It explains cascades and quantifies rule-based mitigations with `evaluate_mitigation`, and is clearly labelled.

## 7. Running DEEPTRACE

Requirements: Node 20+ (tested on 22), Python 3.11+ (tested on 3.13).

```bash
cp .env.example .env          # optional: add NEXT_PUBLIC_CESIUM_ION_TOKEN and ANTHROPIC_API_KEY
make setup                    # npm install (copies CesiumJS to public/cesium) + backend venv
make dev                      # backend :8000 + frontend :3000  →  http://localhost:3000
```

Or run them separately:

```bash
cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000
npx next dev -p 3000
```

| Without… | You still get |
|---|---|
| `NEXT_PUBLIC_CESIUM_ION_TOKEN` | Dark CARTO basemap, full network, simulation and analyst; no streamed 3D buildings or terrain (a notice explains how to enable them) |
| `ANTHROPIC_API_KEY` | The deterministic offline analyst (labelled) |
| The backend | Offline snapshot mode from the committed `public/demo/snapshot.json`: the network, all presets, the demo comparison, engine traces of the major assets and facilities, single failures of major assets, the engine's single-point-of-failure set and the recorded answer to the demo question (replayed only while the demo's scenario A is on screen), all precomputed by the engine (labelled OFFLINE SNAPSHOT). Anything not precomputed says so instead of being approximated. Regenerate it with `make snapshot` after changing data or engine. If the backend becomes unreachable mid-session, the app switches to the snapshot (the toolbar badge changes) and returns to live mode when `/api/health` answers again. |

**Tests**: `make test` runs the pytest suite (engine, cascades, metrics, dataset checks,
ingestion with mocked HTTP, API, analyst loop with a fake Claude client) and the
TypeScript typecheck. The end-to-end demo check (needs Playwright and both servers)
plays all ten demo steps headlessly, screenshots each one and fails on page errors:

```bash
node scripts/e2e-demo.cjs --out e2e-shots            # live backend
node scripts/e2e-demo.cjs --out e2e-shots --offline  # backend blocked → snapshot fallback
node scripts/e2e-races.cjs                           # async races: slow/stale responses, mid-session engine loss
```

API docs: http://localhost:8000/docs.

### Deployment

* **Frontend**: `npm run build && npm start` (or any Next.js host). Set `NEXT_PUBLIC_*` variables at build time and restrict the Cesium token to your domain.
* **Backend**: `uvicorn app.main:app --host 0.0.0.0 --port 8000` behind HTTPS. Set `DEEPTRACE_CORS_ORIGINS` to the frontend origin and keep `ANTHROPIC_API_KEY` server-side only.
* **Static-only demo**: the frontend alone serves the committed offline snapshot (re-run `make snapshot` before building if data or engine changed).

## 8. Reproducing the demo

1. Start both servers (`make dev`) and open http://localhost:3000.
2. Click **Demo** in the toolbar and use **Next** (or →) to step through:
   1. **Overview**: the 3D city with a slow cinematic orbit.
   2. **Deep Mode**: the x-ray transition and the move to the underground camera.
   3. **Reveal**: layers appear one by one (corridors, water, power, internet, transport, facilities).
   4. **Select**: the focus distribution substation is selected and the camera flies to it.
   5. **Trace**: its upstream supply, downstream feeders and cross-system dependents light up.
   6. **Fail**: demo scenario A (substation failure) runs.
   7. **Cascade**: the animated propagation shows de-energised vaults, tie-switch restoration, a pump losing power, cell sites on battery and signals going dark.
   8. **Ask the AI**: “Why did this happen, and what could we do differently?” The analyst calls the engine and quantifies mitigations.
   9. **Alternative**: scenario B (a utility-corridor strike, a common-cause power + fibre failure).
   10. **Compare**: side-by-side metrics, the verdict and the A/B difference on the map.
3. **Reset demo** restarts from step 1. **Restore world** clears every scenario, trace and highlight.

The demo uses the fixed dataset in `backend/datasets/regions/atlanta-downtown/` and
deterministic simulations, so it plays out identically every time. It makes no external
API calls apart from optional Cesium streaming and the optional LLM. If the backend fails
mid-presentation, the app switches to the precomputed snapshot on the next engine call.
Every async step is cancellable: **Exit demo**, **Reset demo** and **Restore world** stop the
step, simulation, trace or analyst answer in flight, so a slow response can never re-apply
state the presenter just cleared; exiting mid-reveal turns every layer back on. Steps can be
reached in any order (step chips, ← →): a step that is about scenario A, such as the analyst
question, puts A on screen first. Runs, comparisons and analyst questions share one timeline,
and an analyst answer counts as asked when its question was sent. Nothing started before asking
takes the map back from the answer when it lands later (an older slot run still fills its slot,
and the analyst's comparison then shows "Slots changed since this comparison"). The answer is
held back only by something started after asking that has already landed: the map, the
comparison or that slot, including the answer's highlights. A newer request still in flight
replaces the answer when it lands, and one that failed or was cancelled never counts. A streaming analyst answer can be stopped at any time, and the
backend sends SSE heartbeats so a stalled connection is detected (90 s without data) rather
than hanging.

## 9. Limitations

* The infrastructure network is **illustrative** (SIMULATED). It shows plausible structures (radial feeders with open ties, looped water grids with valves, dual-homed fibre rings, shared duct banks), not real assets.
* Street alignments and landmark positions are **approximate** (ESTIMATED) until OSM ingestion is run, so some network lines may not sit exactly on the streets shown by the streamed buildings.
* The simulation uses explainable surrogates: no AC power flow, no transient hydraulics, no traffic assignment equilibrium, and static backup durations. Use it for understanding and communication, not for engineering decisions.
* Underground depths are exaggerated for visibility (adjustable), and true burial depths are 1–3 m for most utilities.
* Cesium ion streaming and the Claude API could not be exercised inside the build container (network policy). Both code paths follow the official APIs, fail gracefully, and are covered by fallbacks and tests with fakes.

## 10. Credits

See [ASSET_CREDITS.md](ASSET_CREDITS.md). Map data © OpenStreetMap contributors (ODbL).
3D city and terrain via Cesium ion. CesiumJS is Apache-2.0.
