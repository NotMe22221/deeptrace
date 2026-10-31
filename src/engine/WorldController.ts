/**
 * DEEPTRACE world engine.
 *
 * Owns the Cesium Viewer and every renderer. Subscribes to the zustand store and re-renders when
 * layers / deep mode / selection / trace / highlight / simulation result / playback / comparison
 * change. Registers the imperative WorldApi (camera choreography) through engine/worldBridge.
 *
 *   CityViewer (React) -> new WorldController(C, container)
 *     ├─ scene look: midnight globe, dusk atmosphere, fog, FXAA, saturation-gated bloom + grade
 *     ├─ basemap / terrain / OSM buildings (Cesium ion when a token is present, graceful fallback)
 *     ├─ NetworkGeometry   depth transform (ground + relative elevation, depthScale x deepT)
 *     ├─ EdgeRenderer      glowing lines, ghost traces, corridor tubes, dependency arcs
 *     ├─ NodeRenderer      icons, halos, labels (+declutter), 3D glyphs, drop lines, selection
 *     ├─ ParticleSystem    flow sprites + trace pulses
 *     ├─ EffectsLayer      shockwaves, ripples, outage glows
 *     ├─ StrataLayer       Deep Mode strata planes + surface grid
 *     ├─ BuildingStyler    OSM Buildings custom shaders (lit windows, blackout, x-ray)
 *     ├─ CameraDirector    flights, deep view, orbit
 *     ├─ PickController    hover / click / double-click
 *     └─ ModelLodManager   optional detailed models (manifest)
 */
import type * as Cesium from "cesium";
import { useStore, type DeeptraceState } from "@/lib/store";
import type { InfrastructureNetwork } from "@/types/infrastructure";
import { CameraDirector } from "./CameraDirector";
import type { CesiumModule } from "./geographic/cesiumLoader";
import { clamp, easeInOutCubic, lerp, LocalFrame } from "./geographic/LocalFrame";
import { PickController } from "./interaction/PickController";
import { BuildingStyler, MAX_ZONES, type BlackoutZone } from "./rendering/BuildingStyler";
import { BLACKOUT_STATES, computeDisplay, indexResult, type DisplayModel } from "./rendering/displayState";
import { EdgeRenderer, type PickId } from "./rendering/EdgeRenderer";
import { EffectsLayer, type RingSpec } from "./rendering/EffectsLayer";
import { ModelLodManager } from "./rendering/ModelLodManager";
import { NetworkGeometry } from "./rendering/NetworkGeometry";
import { NodeRenderer } from "./rendering/NodeRenderer";
import { nodeStateRgb, type RGB } from "./rendering/palette";
import { ParticleSystem } from "./rendering/ParticleSystem";
import { StrataLayer } from "./rendering/StrataLayer";
import type { WorldApi } from "./worldBridge";
import { useWorldUi } from "./worldUi";

export type BasemapMode = "ion-aerial" | "carto-dark" | "osm" | "none";

const DEEP_DURATION = 1.8;

const BRIGHT_FS = `
uniform sampler2D colorTexture;
uniform float threshold;
in vec2 v_textureCoordinates;
void main() {
  vec4 c = texture(colorTexture, v_textureCoordinates);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float sat = (mx - mn) / max(mx, 1e-3);
  // only bright, saturated pixels (network lines, particles, alerts) feed the bloom - not labels
  float w = smoothstep(threshold, threshold + 0.35, mx) * smoothstep(0.18, 0.5, sat);
  out_FragColor = vec4(c.rgb * w, 1.0);
}
`;

const COMPOSE_FS = `
uniform sampler2D colorTexture;
uniform sampler2D bloomTexture;
uniform float intensity;
uniform float vignette;
in vec2 v_textureCoordinates;
void main() {
  vec4 c = texture(colorTexture, v_textureCoordinates);
  vec3 b = texture(bloomTexture, v_textureCoordinates).rgb;
  vec3 col = c.rgb + b * intensity;
  vec2 uv = v_textureCoordinates - 0.5;
  uv.x *= 1.2;
  float v = smoothstep(0.92, 0.28, length(uv));
  col *= mix(1.0 - vignette, 1.0, v);
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col += vec3(0.004, 0.008, 0.02) * (1.0 - smoothstep(0.0, 0.2, lum));
  out_FragColor = vec4(col, c.a);
}
`;

function zoneRadius(type: string): number {
  switch (type) {
    case "transmission_substation":
      return 360;
    case "distribution_substation":
      return 280;
    case "network_vault":
      return 150;
    case "switch":
      return 110;
    default:
      return 130;
  }
}

export class WorldController {
  readonly C: CesiumModule;
  readonly viewer: Cesium.Viewer;
  readonly api: WorldApi;
  readonly camera: CameraDirector;
  readonly edges: EdgeRenderer;
  readonly nodes: NodeRenderer;
  readonly particles: ParticleSystem;
  readonly effects: EffectsLayer;
  readonly strata: StrataLayer;
  readonly models: ModelLodManager;
  buildings: BuildingStyler | null = null;
  private picker: PickController;
  geom: NetworkGeometry | null = null;
  display: DisplayModel | null = null;
  private pendingNetwork: InfrastructureNetwork | null = null;
  private terrainMode: "ellipsoid" | "terrain" = "ellipsoid";
  private deepRaw = 0;
  deepT = 0;
  private deepTarget = 0;
  private deepAnim: { from: number; to: number; t0: number; dur: number } | null = null;
  private dirty = { display: true, positions: true, particles: true, trace: true };
  private lastFrame = performance.now() / 1000;
  private lastDeclutter = 0;
  private lastUiDeep = -1;
  private arrived = false;
  private destroyed = false;
  private unsub: () => void;
  private removePreRender: () => void;
  private bloomStage: Cesium.PostProcessStage | Cesium.PostProcessStageComposite | null = null;
  private translucencyRect: Cesium.Rectangle | null = null;
  private sampling = false;
  private readonly token: string;

  constructor(C: CesiumModule, container: HTMLElement) {
    this.C = C;
    this.token = (process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN ?? "").trim();
    if (this.token) C.Ion.defaultAccessToken = this.token;

    const viewer = new C.Viewer(container, {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      vrButton: false,
      infoBox: false,
      selectionIndicator: false,
      projectionPicker: false,
      scene3DOnly: true,
      skyBox: false,
      shouldAnimate: true,
      terrainProvider: new C.EllipsoidTerrainProvider(),
      msaaSamples: 4,
      orderIndependentTranslucency: true,
      requestRenderMode: false,
      contextOptions: { webgl: { alpha: false, antialias: false, powerPreference: "high-performance" } },
    });
    this.viewer = viewer;
    this.setupLook();

    this.edges = new EdgeRenderer(C, viewer.scene);
    this.strata = new StrataLayer(C, viewer.scene);
    this.effects = new EffectsLayer(C, viewer.scene);
    this.nodes = new NodeRenderer(C, viewer.scene);
    this.particles = new ParticleSystem(C, viewer.scene);
    this.models = new ModelLodManager(C, viewer);

    this.camera = new CameraDirector(C, viewer, {
      geom: () => this.geom,
      region: () => this.geom?.network.region ?? useStore.getState().network?.region ?? null,
      terrain: () => this.terrainMode === "terrain",
      deep: () => useStore.getState().deepMode,
      depthScale: () => useStore.getState().depthScale,
      onOrbitChange: (on) => useWorldUi.getState().set({ orbiting: on }),
    });

    this.picker = new PickController(C, viewer, {
      hover: (id, pointer) => {
        useWorldUi.getState().set({ pointer });
        useStore.getState().setHovered(id?.id ?? null);
      },
      click: (id) => this.onClick(id),
      doubleClick: (id) => this.onDoubleClick(id),
      transient: () => [this.particles.collection, this.particles.pulses, this.effects.flareCollection, this.nodes.halos, this.nodes.selection, this.strata.labels],
    });

    this.api = {
      flyHome: (o) => this.safe(() => this.camera.flyHome(o)),
      flyToNode: (id, o) => this.safe(() => this.camera.flyToNode(id, o)),
      flyToNodes: (ids, o) => this.safe(() => this.camera.flyToNodes(ids, o)),
      flyToDeepView: (o) => this.safe(() => this.camera.flyToDeepView(o)),
      setOrbit: (on) => this.safe(() => this.camera.setOrbit(on)),
      isOrbiting: () => !this.destroyed && this.camera.isOrbiting(),
      zoom: (d) => this.safe(() => this.camera.zoom(d)),
      resetNorth: () => this.safe(() => this.camera.resetNorth()),
      tilt: (d) => this.safe(() => this.camera.tilt(d)),
    };

    const st = useStore.getState();
    const r = st.network?.region;
    this.camera.setSpaceView(r?.center?.[1], r?.center?.[0]);
    this.deepTarget = st.deepMode ? 1 : 0;
    this.deepRaw = this.deepTarget;
    this.deepT = this.deepTarget;
    this.nodes.setShowLabels(st.showLabels);
    if (st.network) this.pendingNetwork = st.network;

    this.unsub = useStore.subscribe((s, p) => this.onStore(s, p));
    this.removePreRender = viewer.scene.preRender.addEventListener(() => this.frame());

    void this.setupGlobeAssets();
    if (typeof window !== "undefined") {
      (window as unknown as { __deeptrace?: unknown }).__deeptrace = { viewer, controller: this };
    }
  }

  private safe(fn: () => void) {
    if (this.destroyed) return;
    try {
      fn();
    } catch (e) {
      console.warn("[deeptrace] camera command failed", e);
    }
  }

  // ------------------------------------------------------------------ look
  private setupLook() {
    const C = this.C;
    const scene = this.viewer.scene;
    scene.backgroundColor = C.Color.fromCssColorString("#03050a");
    const globe = scene.globe;
    globe.baseColor = C.Color.fromCssColorString("#0b1424");
    globe.enableLighting = false;
    globe.showGroundAtmosphere = true;
    globe.depthTestAgainstTerrain = true;
    globe.undergroundColor = C.Color.fromCssColorString("#060c19");
    globe.undergroundColorAlphaByDistance = new C.NearFarScalar(400, 0.85, 12000, 1.0);
    globe.translucency.enabled = false;
    globe.maximumScreenSpaceError = 1.6;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.perFragmentAtmosphere = true;
      scene.skyAtmosphere.hueShift = 0.0;
      scene.skyAtmosphere.saturationShift = 0.05;
      scene.skyAtmosphere.brightnessShift = -0.58;
    }
    // dusk: the atmosphere is lit by the real sun at a fixed evening time (blue hour over the city)
    const atmo = scene.atmosphere;
    atmo.dynamicLighting = C.DynamicAtmosphereLightingType.SUNLIGHT;
    atmo.brightnessShift = -0.3;
    atmo.saturationShift = -0.2;
    atmo.hueShift = 0.0;
    scene.fog.enabled = true;
    scene.fog.density = 2.4e-4;
    scene.fog.minimumBrightness = 0.035;
    scene.highDynamicRange = false;
    scene.postProcessStages.fxaa.enabled = true;
    scene.light = new C.DirectionalLight({ direction: new C.Cartesian3(0.35, -0.6, -0.72), intensity: 2.2 });
    const ssc = scene.screenSpaceCameraController;
    ssc.minimumZoomDistance = 15;
    ssc.maximumZoomDistance = 2.5e7;
    ssc.enableCollisionDetection = true;
    // a fixed evening for anything that still reads the clock
    this.viewer.clock.currentTime = C.JulianDate.fromIso8601("2026-10-31T23:22:00Z");
    this.viewer.clock.shouldAnimate = false;

    // saturation-gated bloom + vignette / grade
    try {
      const bright = new C.PostProcessStage({ name: `dt_bright_${C.createGuid()}`, fragmentShader: BRIGHT_FS, uniforms: { threshold: 0.42 } });
      const blur = C.PostProcessStageLibrary.createBlurStage();
      blur.uniforms.delta = 1.0;
      blur.uniforms.sigma = 3.4;
      blur.uniforms.stepSize = 1.6;
      const brightBlur = new C.PostProcessStageComposite({ name: `dt_bright_blur_${C.createGuid()}`, stages: [bright, blur] });
      const compose = new C.PostProcessStage({
        name: `dt_compose_${C.createGuid()}`,
        fragmentShader: COMPOSE_FS,
        uniforms: { bloomTexture: brightBlur.name, intensity: 0.8, vignette: 0.36 },
      });
      this.bloomStage = scene.postProcessStages.add(
        new C.PostProcessStageComposite({ name: `dt_bloom_${C.createGuid()}`, stages: [brightBlur, compose], inputPreviousStageTexture: false }),
      );
    } catch (e) {
      console.warn("[deeptrace] post-processing unavailable", e);
    }
  }

  private basemapMode(): BasemapMode {
    const env = (process.env.NEXT_PUBLIC_DEEPTRACE_BASEMAP ?? "").trim().toLowerCase();
    const valid: BasemapMode[] = ["ion-aerial", "carto-dark", "osm", "none"];
    let mode: BasemapMode = valid.includes(env as BasemapMode) ? (env as BasemapMode) : this.token ? "ion-aerial" : "carto-dark";
    if (mode === "ion-aerial" && !this.token) mode = "carto-dark";
    return mode;
  }

  private addTemplateImagery(mode: "carto-dark" | "osm") {
    const C = this.C;
    const provider =
      mode === "carto-dark"
        ? new C.UrlTemplateImageryProvider({
            url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
            subdomains: "abcd",
            customTags: { r: () => (window.devicePixelRatio > 1 ? "@2x" : "") },
            credit: "© OpenStreetMap contributors © CARTO",
            maximumLevel: 19,
          })
        : new C.UrlTemplateImageryProvider({
            url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
            credit: "© OpenStreetMap contributors",
            maximumLevel: 19,
          });
    let failures = 0;
    provider.errorEvent.addEventListener((err: Cesium.TileProviderError) => {
      // listening suppresses Cesium's console spam; report once if the tile server is unreachable
      failures++;
      err.retry = false;
      if (failures === 8 && !this.destroyed) useStore.getState().setWorldStatus({ imagery: `${mode} (unreachable)` });
    });
    const layer = this.viewer.imageryLayers.addImageryProvider(provider);
    if (mode === "carto-dark") {
      layer.brightness = 1.05;
      layer.contrast = 1.12;
      layer.saturation = 0.5;
      layer.alpha = 0.92;
    } else {
      layer.brightness = 0.32;
      layer.contrast = 1.3;
      layer.saturation = 0.12;
      layer.gamma = 1.1;
      layer.alpha = 0.9;
    }
    return layer;
  }

  /** Imagery, terrain and buildings. Every async load is guarded; status goes to the store. */
  private async setupGlobeAssets() {
    const C = this.C;
    const setStatus = (p: Parameters<DeeptraceState["setWorldStatus"]>[0]) => {
      if (!this.destroyed) useStore.getState().setWorldStatus(p);
    };
    const mode = this.basemapMode();
    setStatus({ status: "ready", ionToken: !!this.token, imagery: mode });

    // ---- imagery
    try {
      if (mode === "ion-aerial") {
        const layer = C.ImageryLayer.fromProviderAsync(C.createWorldImageryAsync({ style: C.IonWorldImageryStyle.AERIAL }), {});
        // midnight treatment: dark, desaturated, slightly crushed
        layer.brightness = 0.34;
        layer.contrast = 1.32;
        layer.saturation = 0.2;
        layer.gamma = 1.05;
        layer.alpha = 0.94;
        layer.readyEvent.addEventListener(() => setStatus({ imagery: "ion-aerial" }));
        layer.errorEvent.addEventListener(() => {
          if (this.destroyed) return;
          this.viewer.imageryLayers.remove(layer);
          this.addTemplateImagery("carto-dark");
          setStatus({ imagery: "carto-dark (ion imagery failed)" });
        });
        this.viewer.imageryLayers.add(layer);
      } else if (mode === "carto-dark" || mode === "osm") {
        this.addTemplateImagery(mode);
      }
    } catch (e) {
      console.warn("[deeptrace] imagery setup failed", e);
      setStatus({ imagery: "none" });
    }

    if (!this.token) {
      setStatus({
        buildings: "unavailable",
        terrain: "ellipsoid",
        message: "Set NEXT_PUBLIC_CESIUM_ION_TOKEN to stream Cesium OSM Buildings and World Terrain",
      });
      return;
    }

    // ---- terrain
    setStatus({ terrain: "loading", buildings: "loading", message: null });
    try {
      const tp = await C.createWorldTerrainAsync();
      if (this.destroyed) return;
      this.viewer.scene.terrainProvider = tp;
      this.terrainMode = "terrain";
      setStatus({ terrain: "ion-world" });
      if (this.geom) void this.sampleGround();
    } catch (e) {
      console.warn("[deeptrace] world terrain unavailable", e);
      setStatus({ terrain: "ellipsoid" });
    }
    if (this.destroyed) return;

    // ---- buildings
    const region = useStore.getState().network?.region;
    const frame = this.geom?.frame ?? new LocalFrame(C, region?.center?.[1] ?? -84.39, region?.center?.[0] ?? 33.75, 0);
    const styler = new BuildingStyler(C, this.viewer.scene, frame);
    this.buildings = styler;
    const offset = this.terrainMode === "ellipsoid" ? (region?.ground_elevation_m ?? 0) : 0;
    const ok = await styler.load(offset);
    if (this.destroyed) return;
    if (!ok) {
      this.buildings = null;
      styler.destroy();
    } else if (this.geom) {
      styler.setFrame(this.geom.frame);
      this.dirty.display = true;
    }
    setStatus({
      buildings: ok ? "ion-osm" : "unavailable",
      message: ok ? null : "Cesium OSM Buildings could not be loaded with the configured ion token",
    });
  }

  /** Sample world terrain once for every node and edge vertex. */
  private async sampleGround() {
    const C = this.C;
    const geom = this.geom;
    if (!geom || this.sampling || this.terrainMode !== "terrain") return;
    this.sampling = true;
    try {
      const pts = geom.samplePoints();
      const cartos = pts.map((p) => C.Cartographic.fromDegrees(p.lon, p.lat));
      const center = C.Cartographic.fromDegrees(geom.frame.lon, geom.frame.lat);
      cartos.push(center);
      const res = await C.sampleTerrainMostDetailed(this.viewer.scene.terrainProvider, cartos);
      if (this.destroyed || geom !== this.geom) return;
      const heights = res.map((c) => c.height);
      const centerH = heights.pop() ?? geom.groundBase;
      geom.applyGround(heights, Number.isFinite(centerH) ? centerH : geom.groundBase);
      this.afterGroundChange();
    } catch (e) {
      console.warn("[deeptrace] terrain sampling failed", e);
    } finally {
      this.sampling = false;
    }
  }

  private afterGroundChange() {
    const geom = this.geom;
    if (!geom) return;
    this.nodes.rebuildGlyphs();
    this.strata.build(geom);
    this.buildings?.setFrame(geom.frame);
    this.models.setGeometry(geom);
    this.dirty.positions = true;
    this.dirty.display = true;
    this.dirty.trace = true;
  }

  // ------------------------------------------------------------------ store
  private onStore(s: DeeptraceState, p: DeeptraceState) {
    if (this.destroyed) return;
    if (s.network !== p.network && s.network) this.pendingNetwork = s.network;
    if (s.deepMode !== p.deepMode) this.deepTarget = s.deepMode ? 1 : 0;
    if (s.depthScale !== p.depthScale) this.dirty.positions = true;
    if (s.showLabels !== p.showLabels) {
      this.nodes.setShowLabels(s.showLabels);
      this.dirty.display = true;
    }
    if (s.showParticles !== p.showParticles) this.dirty.particles = true;
    if (
      s.layers !== p.layers ||
      s.showDependencies !== p.showDependencies ||
      s.result !== p.result ||
      s.baseline !== p.baseline ||
      s.playback.step !== p.playback.step ||
      s.compareView !== p.compareView ||
      s.comparison !== p.comparison ||
      s.trace !== p.trace ||
      s.traceVisible !== p.traceVisible ||
      s.highlight !== p.highlight ||
      s.selectedNodeId !== p.selectedNodeId ||
      s.selectedEdgeId !== p.selectedEdgeId
    ) {
      this.dirty.display = true;
    }
    if (s.trace !== p.trace || s.traceVisible !== p.traceVisible) this.dirty.trace = true;
    if (s.selectedNodeId !== p.selectedNodeId) this.nodes.setSelected(s.selectedNodeId);
    if (s.hoveredId !== p.hoveredId) {
      this.nodes.setHovered(s.hoveredId);
      this.edges.setHovered(s.hoveredId);
      this.edges.touch(s.hoveredId);
      this.edges.touch(p.hoveredId);
    }
    this.cascadeEffects(s, p);
  }

  /** One-shot cascade effects reacting to playback changes (the UI owns the playback timer). */
  private cascadeEffects(s: DeeptraceState, p: DeeptraceState) {
    const geom = this.geom;
    const r = s.result;
    if (!geom || !r || s.compareView === "diff") return;
    const pb = s.playback;
    const pp = p.playback;
    const now = performance.now() / 1000;
    if (pb.runId !== pp.runId) {
      if (pb.playing && pb.step === 0) this.initiatingEffects(s);
      return;
    }
    if (r !== p.result) return;
    if (pb.step > pp.step && pb.step - pp.step <= 3) {
      const ri = indexResult(r);
      for (let k = pp.step + 1; k <= pb.step; k++) {
        // ripples at nodes newly affected in this step, grouped by state colour
        const groups = new Map<string, { rgb: RGB; specs: RingSpec[] }>();
        for (const a of r.affected_nodes) {
          if (a.step !== k) continue;
          const i = geom.nodeIndex.get(a.node_id);
          if (i === undefined) continue;
          const n = geom.nodes[i];
          const g = groups.get(a.state) ?? { rgb: nodeStateRgb(a.state), specs: [] };
          g.specs.push({ lon: n.lon, lat: n.lat, height: n.ground + n.rel + 1.5 });
          groups.set(a.state, g);
        }
        groups.forEach((g) => this.effects.ripple(g.specs, g.rgb));
        // interrupted edges flash, then settle dark; alternative paths flash green
        const flashIds = r.interrupted_edges.filter((ie) => ie.step === k).map((ie) => ie.edge_id);
        for (const [eid, st] of ri.edgeStep) if (st === k && ri.altEdges.has(eid)) flashIds.push(eid);
        this.edges.flash(flashIds, now);
        for (const eid of flashIds) {
          if (!ri.altEdges.has(eid)) continue;
          const e = geom.edges[geom.edgeIndex.get(eid) ?? -1];
          if (e) this.effects.flare(geom.pointAlong(e, e.length / 2, new this.C.Cartesian3()), [0.3, 0.95, 0.5], 140, 1.1);
        }
      }
    }
  }

  private initiatingEffects(s: DeeptraceState) {
    const geom = this.geom;
    const r = s.result;
    if (!geom || !r) return;
    const C = this.C;
    const specs: RingSpec[] = [];
    const positions: Cesium.Cartesian3[] = [];
    for (const id of r.failed_nodes) {
      const i = geom.nodeIndex.get(id);
      if (i === undefined) continue;
      const n = geom.nodes[i];
      specs.push({ lon: n.lon, lat: n.lat, height: n.ground + n.rel + 1.5 });
      positions.push(C.Cartesian3.clone(n.pos));
    }
    for (const id of r.failed_edges) {
      const i = geom.edgeIndex.get(id);
      if (i === undefined) continue;
      const e = geom.edges[i];
      const mid = Math.floor(e.n / 2);
      const p = geom.pointAlong(e, e.length / 2, new C.Cartesian3());
      specs.push({ lon: e.lon[mid], lat: e.lat[mid], height: e.ground[mid] + 1.5 });
      positions.push(p);
    }
    if (specs.length) this.effects.shockwave(specs, positions);
    const now = performance.now() / 1000;
    this.edges.flash([...r.failed_edges, ...r.interrupted_edges.filter((ie) => ie.step === 0).map((ie) => ie.edge_id)], now);
    const ui = useWorldUi.getState();
    ui.set({ flash: ui.flash + 1 });
  }

  private onClick(id: PickId) {
    const st = useStore.getState();
    if (id.dt === "node") void st.selectNode(id.id);
    else st.selectEdge(id.id);
  }

  private onDoubleClick(id: PickId) {
    const st = useStore.getState();
    if (id.dt === "node") {
      void st.selectNode(id.id, { fly: true });
    } else {
      st.selectEdge(id.id);
      const e = st.index?.edges.get(id.id);
      if (e) this.camera.flyToNodes([e.source_node, e.target_node]);
    }
  }

  // ------------------------------------------------------------------ frame
  private rebuild(network: InfrastructureNetwork) {
    const C = this.C;
    const ground = this.terrainMode === "terrain" ? (network.region.ground_elevation_m ?? 0) : 0;
    const geom = new NetworkGeometry(C, network, ground);
    this.geom = geom;
    this.display = null;
    const st = useStore.getState();
    geom.update({ depthScale: st.depthScale, deepT: this.deepT }, true);
    this.edges.build(geom);
    this.nodes.build(geom);
    this.nodes.setSelected(st.selectedNodeId);
    this.strata.build(geom);
    this.models.setGeometry(geom);
    this.buildings?.setFrame(geom.frame);
    // fixed key light from the south-east, consistent at any time of day
    const f = geom.frame;
    const toLight = new C.Cartesian3();
    C.Cartesian3.add(C.Cartesian3.multiplyByScalar(f.east, 0.45, new C.Cartesian3()), C.Cartesian3.multiplyByScalar(f.north, -0.55, new C.Cartesian3()), toLight);
    C.Cartesian3.add(toLight, C.Cartesian3.multiplyByScalar(f.up, 0.7, new C.Cartesian3()), toLight);
    C.Cartesian3.normalize(toLight, toLight);
    this.viewer.scene.light = new C.DirectionalLight({ direction: C.Cartesian3.negate(toLight, new C.Cartesian3()), intensity: 2.4 });
    // globe translucency is limited to a window around the district
    const [s, w, n, e] = network.region.bbox;
    const padLat = (n - s) * 0.35;
    const padLon = (e - w) * 0.35;
    this.translucencyRect = C.Rectangle.fromDegrees(w - padLon, s - padLat, e + padLon, n + padLat);
    this.dirty = { display: true, positions: true, particles: true, trace: true };
    if (this.terrainMode === "terrain") void this.sampleGround();
    if (!this.arrived) {
      this.arrived = true;
      this.camera.arrive();
    }
  }

  private applyGlobe(deepT: number) {
    const C = this.C;
    const globe = this.viewer.scene.globe;
    const tr = globe.translucency;
    if (deepT > 0.002) {
      tr.enabled = true;
      tr.frontFaceAlphaByDistance = new C.NearFarScalar(250, lerp(1, 0.16, deepT), 12000, lerp(1, 0.7, deepT));
      tr.backFaceAlpha = lerp(1, 0.28, deepT);
      if (this.translucencyRect) tr.rectangle = this.translucencyRect;
    } else {
      tr.enabled = false;
    }
    this.viewer.scene.screenSpaceCameraController.enableCollisionDetection = this.deepTarget === 0 && deepT < 0.5;
  }

  private computeZones(model: DisplayModel): BlackoutZone[] {
    const geom = this.geom;
    if (!geom || model.diff) return [];
    type Z = { x: number; y: number; r: number };
    let zs: Z[] = [];
    for (const n of geom.nodes) {
      if (n.node.system !== "power") continue;
      const v = model.nodes[n.idx];
      if (!v.impacted || !BLACKOUT_STATES.has(v.state)) continue;
      zs.push({ x: n.x, y: n.y, r: zoneRadius(n.node.type) });
    }
    // merge the closest pairs until the shader's zone budget fits
    while (zs.length > MAX_ZONES) {
      let bi = 0,
        bj = 1,
        bd = Infinity;
      for (let i = 0; i < zs.length; i++)
        for (let j = i + 1; j < zs.length; j++) {
          const d = Math.hypot(zs[i].x - zs[j].x, zs[i].y - zs[j].y) - zs[i].r - zs[j].r;
          if (d < bd) {
            bd = d;
            bi = i;
            bj = j;
          }
        }
      const a = zs[bi];
      const b = zs[bj];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      let m: Z;
      if (d + b.r <= a.r) m = a;
      else if (d + a.r <= b.r) m = b;
      else {
        const r = (d + a.r + b.r) / 2;
        const t = d > 1e-6 ? (r - a.r) / d : 0;
        m = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, r };
      }
      zs = zs.filter((_, k) => k !== bi && k !== bj);
      zs.push(m);
    }
    const f = geom.frame;
    return zs.map((z) => {
      const [lon, lat] = f.toLonLat(z.x, z.y);
      return { position: this.C.Cartesian3.fromDegrees(lon, lat, f.height), radius: z.r };
    });
  }

  private frame() {
    if (this.destroyed) return;
    const now = performance.now() / 1000;
    const dt = clamp(now - this.lastFrame, 0, 0.1);
    this.lastFrame = now;
    try {
      if (this.pendingNetwork) {
        const n = this.pendingNetwork;
        this.pendingNetwork = null;
        this.rebuild(n);
      }
      const geom = this.geom;
      if (!geom) {
        this.camera.update(dt);
        return;
      }
      const st = useStore.getState();

      // ---- deep transition (wall-clock based so it takes ~1.8 s at any frame rate)
      let deepChanged = false;
      if (this.deepRaw !== this.deepTarget || this.deepAnim) {
        if (!this.deepAnim || this.deepAnim.to !== this.deepTarget) {
          const span = Math.abs(this.deepTarget - this.deepRaw);
          this.deepAnim = { from: this.deepRaw, to: this.deepTarget, t0: now, dur: DEEP_DURATION * Math.max(0.15, span) };
        }
        const a = this.deepAnim;
        const k = clamp((now - a.t0) / a.dur, 0, 1);
        this.deepRaw = lerp(a.from, a.to, k);
        if (k >= 1) {
          this.deepRaw = a.to;
          this.deepAnim = null;
          this.dirty.particles = true;
        }
        this.deepT = easeInOutCubic(this.deepRaw);
        deepChanged = true;
      }
      let positionsChanged = false;
      if (deepChanged || this.dirty.positions) {
        this.dirty.positions = false;
        geom.update({ depthScale: st.depthScale, deepT: this.deepT }, true);
        this.edges.updatePositions();
        this.nodes.updatePositions(this.deepT);
        this.edges.setDeepT(this.deepT);
        this.edges.restyle(now);
        this.applyGlobe(this.deepT);
        this.strata.update(this.deepT, st.depthScale);
        positionsChanged = true;
        if (this.deepT > 0 && this.deepT < 1 && Math.abs(this.deepT - 0.5) < 0.04) this.dirty.particles = true;
      }

      // ---- display state
      if (this.dirty.display) {
        this.dirty.display = false;
        this.display = computeDisplay(geom, st);
        this.edges.applyDisplay(this.display, this.deepT);
        this.nodes.applyDisplay(this.display);
        const zones = this.computeZones(this.display);
        this.buildings?.setZones(zones);
        this.effects.setOutageZones(
          zones.map((z) => {
            const c = this.C.Cartographic.fromCartesian(z.position);
            return { lon: this.C.Math.toDegrees(c.longitude), lat: this.C.Math.toDegrees(c.latitude), height: geom.frame.height + 1.6, radius: z.radius };
          }),
        );
        this.dirty.particles = true;
      }
      if (this.dirty.particles && this.display) {
        this.dirty.particles = false;
        this.particles.rebuild(geom, this.display, this.deepT, st.showParticles);
      }
      if (this.dirty.trace) {
        this.dirty.trace = false;
        const tr = st.traceVisible ? st.trace : null;
        this.particles.setTrace(geom, tr?.node_id ?? null, tr?.source_paths ?? null);
      }

      // ---- per-frame animation
      this.edges.animate(now);
      this.nodes.animate(now);
      this.particles.update(now);
      this.effects.update(now);
      this.buildings?.update(dt, now, this.deepT);
      this.camera.update(dt);
      this.models.update(positionsChanged);
      if (now - this.lastDeclutter > 0.2 || positionsChanged) {
        this.lastDeclutter = now;
        this.nodes.declutter();
      }
      if (Math.abs(this.deepT - this.lastUiDeep) > 0.01 || ((this.deepT === 0 || this.deepT === 1) && this.lastUiDeep !== this.deepT)) {
        this.lastUiDeep = this.deepT;
        useWorldUi.getState().set({ deepT: this.deepT });
      }
    } catch (e) {
      console.error("[deeptrace] world frame failed", e);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsub();
    this.removePreRender();
    this.picker.destroy();
    this.camera.destroy();
    this.models.destroy();
    this.buildings?.destroy();
    this.edges.destroy();
    this.nodes.destroy();
    this.particles.destroy();
    this.effects.destroy();
    this.strata.destroy();
    if (this.bloomStage && !this.viewer.isDestroyed()) {
      try {
        this.viewer.scene.postProcessStages.remove(this.bloomStage);
      } catch {
        /* ignore */
      }
    }
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
    const w = window as unknown as { __deeptrace?: { controller?: unknown } };
    if (w.__deeptrace?.controller === this) delete w.__deeptrace;
  }
}
