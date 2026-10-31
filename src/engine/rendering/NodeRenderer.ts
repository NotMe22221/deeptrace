/**
 * Infrastructure nodes:
 *  - icons: canvas-drawn circular glyph billboards (surface) / rounded-square badges (underground)
 *  - halos: soft tinted glows for impacted / highlighted / diff nodes
 *  - labels: important assets, with distance conditions and screen-space decluttering
 *  - glyphs: instanced 3D shapes (hex prisms, cylinders, spheres, discs) for depth perception;
 *    per-instance colour / show / offset attributes let Deep Mode move them without rebuilding
 *  - drop lines: faint verticals from the surface to underground nodes in Deep Mode
 *  - selection: pulsing ring + reticle on the selected node
 */
import type * as Cesium from "cesium";
import type { CesiumModule } from "@/engine/geographic/cesiumLoader";
import { smoothstep } from "@/engine/geographic/LocalFrame";
import type { DisplayModel, NodeVisual } from "./displayState";
import type { PickId } from "./EdgeRenderer";
import { glowSprite, ICON_PX, iconKey, iconTier, nodeIcon, reticleSprite, ringSprite, type IconTier } from "./icons";
import { createMaterial, setDash, setParams } from "./materials";
import type { NetworkGeometry, NodeGeom } from "./NetworkGeometry";
import { rgbToHex, setColor } from "./palette";

interface GlyphSpec {
  shape: "hex" | "cyl" | "box" | "sphere" | "disc";
  r: number;
  h: number;
  alpha: number;
}

const GLYPHS: Record<string, GlyphSpec> = {
  transmission_substation: { shape: "hex", r: 24, h: 16, alpha: 0.85 },
  distribution_substation: { shape: "hex", r: 16, h: 11, alpha: 0.85 },
  switch: { shape: "box", r: 5, h: 5, alpha: 0.85 },
  network_vault: { shape: "box", r: 6, h: 4, alpha: 0.9 },
  supply_source: { shape: "cyl", r: 11, h: 8, alpha: 0.85 },
  pump_station: { shape: "cyl", r: 14, h: 10, alpha: 0.85 },
  storage_tank: { shape: "cyl", r: 11, h: 18, alpha: 0.85 },
  valve: { shape: "sphere", r: 3.2, h: 6.4, alpha: 0.95 },
  junction: { shape: "sphere", r: 2.4, h: 4.8, alpha: 0.9 },
  service_zone: { shape: "disc", r: 170, h: 0.6, alpha: 0.085 },
  internet_exchange: { shape: "hex", r: 18, h: 22, alpha: 0.85 },
  central_office: { shape: "box", r: 13, h: 16, alpha: 0.85 },
  data_center: { shape: "box", r: 15, h: 13, alpha: 0.85 },
  fiber_hub: { shape: "sphere", r: 4, h: 8, alpha: 0.9 },
  transit_station: { shape: "cyl", r: 22, h: 7, alpha: 0.7 },
  utility_vault: { shape: "box", r: 6, h: 4, alpha: 0.9 },
};

const LABEL_TYPES = new Set([
  "transmission_substation",
  "distribution_substation",
  "internet_exchange",
  "central_office",
  "data_center",
  "pump_station",
  "storage_tank",
  "supply_source",
  "transit_station",
  "transit_hub",
  "gateway",
  "hospital",
  "emergency_services",
  "government",
  "university",
  "venue",
  "service_zone",
]);

const LABEL_FONT = "600 11.5px 'Inter Variable', Inter, system-ui, sans-serif";

interface NodeEntry {
  g: NodeGeom;
  pickId: PickId;
  tier: IconTier;
  icon: Cesium.Billboard;
  halo: Cesium.Billboard;
  label: Cesium.Label | null;
  labelW: number;
  labelFar: number;
  labelPriority: number;
  glyph: GlyphSpec | null;
  /** billboard lift above the node point (sits on top of its 3D glyph) */
  lift: number;
  drop: Cesium.Polyline | null;
  dropMat: Cesium.Material | null;
  vis?: NodeVisual;
  iconKey: string;
  labelAllowed: boolean;
}

export class NodeRenderer {
  private readonly C: CesiumModule;
  private readonly scene: Cesium.Scene;
  readonly halos: Cesium.BillboardCollection;
  readonly icons: Cesium.BillboardCollection;
  readonly labels: Cesium.LabelCollection;
  readonly drops: Cesium.PolylineCollection;
  readonly selection: Cesium.BillboardCollection;
  private glyphPrim: Cesium.Primitive | null = null;
  private glyphReady = false;
  private entries: NodeEntry[] = [];
  private byId = new Map<string, NodeEntry>();
  private display: DisplayModel | null = null;
  private deepT = 0;
  private showLabels = true;
  private hovered: string | null = null;
  private selected: string | null = null;
  private selRing: Cesium.Billboard;
  private selRing2: Cesium.Billboard;
  private selReticle: Cesium.Billboard;
  private readonly scratch: Cesium.Cartesian3;
  private readonly scratch2: Cesium.Cartesian3;
  private readonly tmpColor: Cesium.Color;
  private glyphDirty = true;
  private measure: CanvasRenderingContext2D | null = null;

  constructor(C: CesiumModule, scene: Cesium.Scene) {
    this.C = C;
    this.scene = scene;
    this.drops = scene.primitives.add(new C.PolylineCollection());
    this.halos = scene.primitives.add(new C.BillboardCollection({ scene }));
    this.icons = scene.primitives.add(new C.BillboardCollection({ scene }));
    this.selection = scene.primitives.add(new C.BillboardCollection({ scene }));
    this.labels = scene.primitives.add(new C.LabelCollection({ scene }));
    this.scratch = new C.Cartesian3();
    this.scratch2 = new C.Cartesian3();
    this.tmpColor = new C.Color();
    const common = {
      show: false,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      position: C.Cartesian3.ZERO,
    };
    this.selRing = this.selection.add({ ...common, image: ringSprite(), width: 64, height: 64 });
    this.selRing2 = this.selection.add({ ...common, image: ringSprite(), width: 64, height: 64 });
    this.selReticle = this.selection.add({ ...common, image: reticleSprite(), width: 52, height: 52 });
  }

  build(geom: NetworkGeometry) {
    const C = this.C;
    this.halos.removeAll();
    this.icons.removeAll();
    this.labels.removeAll();
    this.drops.removeAll();
    this.entries = [];
    this.byId.clear();
    this.display = null;
    for (const g of geom.nodes) {
      const n = g.node;
      const tier = iconTier(n.type);
      const pickId: PickId = { dt: "node", id: n.id };
      const glyph = GLYPHS[n.type] ?? null;
      const lift = glyph && glyph.shape !== "disc" ? (g.underground ? glyph.h / 2 + 1.5 : glyph.h + 2) : 0;
      const px = ICON_PX[tier] + 6;
      const near = tier === "minor" ? new C.NearFarScalar(150, 1.0, 2600, 0.45) : tier === "medium" ? new C.NearFarScalar(250, 1.0, 5000, 0.55) : new C.NearFarScalar(300, 1.08, 7000, 0.6);
      const icon = this.icons.add({
        position: g.pos,
        image: nodeIcon({ type: n.type, color: "#9fb3c8", tier, underground: g.underground }),
        width: px,
        height: px,
        id: pickId,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: near,
        translucencyByDistance: tier === "minor" ? new C.NearFarScalar(1400, 1, 3600, 0) : tier === "medium" ? new C.NearFarScalar(3500, 1, 9000, 0.25) : undefined,
      });
      const halo = this.halos.add({
        position: g.pos,
        image: glowSprite("halo"),
        width: px * 2.6,
        height: px * 2.6,
        show: false,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: near,
      });
      const labelAllowed = LABEL_TYPES.has(n.type) || n.critical;
      let label: Cesium.Label | null = null;
      let labelW = 0;
      let labelFar = 0;
      if (labelAllowed) {
        labelFar = tier === "major" ? (n.critical ? 6500 : 4200) : 2400;
        label = this.labels.add({
          position: g.pos,
          text: n.name,
          font: LABEL_FONT,
          fillColor: C.Color.fromCssColorString("#e6ebf4"),
          outlineColor: C.Color.fromCssColorString("#04060b"),
          outlineWidth: 2,
          style: C.LabelStyle.FILL,
          showBackground: true,
          backgroundColor: C.Color.fromCssColorString("rgba(6,10,19,0.74)"),
          backgroundPadding: new C.Cartesian2(7, 4),
          pixelOffset: new C.Cartesian2(0, -(px / 2 + 5)),
          horizontalOrigin: C.HorizontalOrigin.CENTER,
          verticalOrigin: C.VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new C.NearFarScalar(400, 1, 6000, 0.78),
          id: pickId,
        });
        labelW = this.textWidth(n.name) + 16;
      }
      let drop: Cesium.Polyline | null = null;
      let dropMat: Cesium.Material | null = null;
      if (g.underground) {
        dropMat = createMaterial(C, "line", setColor(this.tmpColor, [0.6, 0.7, 0.85], 0.4), [0, 0, 1, 0]);
        drop = this.drops.add({ positions: [g.base, g.pos], width: 1.25, material: dropMat, show: false });
      }
      const e: NodeEntry = {
        g,
        pickId,
        tier,
        icon,
        halo,
        label,
        labelW,
        labelFar,
        labelPriority: (tier === "major" ? 100 : 30) + (n.critical ? 60 : 0),
        glyph,
        lift,
        drop,
        dropMat,
        iconKey: "",
        labelAllowed,
      };
      this.entries.push(e);
      this.byId.set(n.id, e);
    }
    this.glyphDirty = true;
  }

  private textWidth(t: string) {
    if (!this.measure) {
      const c = document.createElement("canvas");
      this.measure = c.getContext("2d");
      if (this.measure) this.measure.font = LABEL_FONT;
    }
    return this.measure ? this.measure.measureText(t).width : t.length * 6.4;
  }

  /** (Re)build the instanced glyph primitive. Call after ground heights change. */
  rebuildGlyphs() {
    this.glyphDirty = true;
  }

  private buildGlyphPrimitive() {
    const C = this.C;
    const Cx = C as unknown as {
      OffsetGeometryInstanceAttribute?: new (x: number, y: number, z: number) => Cesium.GeometryInstanceAttribute;
      GeometryOffsetAttribute?: { ALL: number };
    };
    if (this.glyphPrim) {
      this.scene.primitives.remove(this.glyphPrim);
      this.glyphPrim = null;
    }
    this.glyphReady = false;
    const instances: Cesium.GeometryInstance[] = [];
    const offsetSupported = !!Cx.OffsetGeometryInstanceAttribute && !!Cx.GeometryOffsetAttribute;
    const offsetAttr = Cx.GeometryOffsetAttribute?.ALL;
    for (const e of this.entries) {
      const sp = e.glyph;
      if (!sp) continue;
      const g = e.g;
      let geometry: unknown;
      const opt = offsetSupported ? { offsetAttribute: offsetAttr } : {};
      if (sp.shape === "sphere") {
        geometry = new C.EllipsoidGeometry({
          radii: new C.Cartesian3(sp.r, sp.r, sp.r),
          stackPartitions: 10,
          slicePartitions: 12,
          vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
          ...opt,
        } as ConstructorParameters<typeof C.EllipsoidGeometry>[0]);
      } else {
        geometry = new C.CylinderGeometry({
          length: sp.h,
          topRadius: sp.r,
          bottomRadius: sp.r,
          slices: sp.shape === "hex" ? 6 : sp.shape === "box" ? 4 : sp.shape === "disc" ? 72 : 20,
          vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
          ...opt,
        } as ConstructorParameters<typeof C.CylinderGeometry>[0]);
      }
      // built at the node's ground point; underground motion is applied with the offset attribute
      const centerRel = g.underground ? 0 : sp.shape === "disc" ? 2 : Math.max(0, g.node.elevation ?? 0) + sp.h / 2 + 0.2;
      const center = C.Cartesian3.add(g.base, C.Cartesian3.multiplyByScalar(g.up, centerRel, this.scratch), new C.Cartesian3());
      const enu = C.Transforms.eastNorthUpToFixedFrame(center);
      if (sp.shape === "box") C.Matrix4.multiplyByMatrix3(enu, C.Matrix3.fromRotationZ(Math.PI / 4), enu);
      const attributes: Record<string, unknown> = {
        color: new C.ColorGeometryInstanceAttribute(1, 1, 1, sp.alpha),
        show: new C.ShowGeometryInstanceAttribute(true),
      };
      if (offsetSupported) attributes.offset = new Cx.OffsetGeometryInstanceAttribute!(0, 0, 0);
      instances.push(
        new C.GeometryInstance({
          geometry: geometry as Cesium.Geometry,
          modelMatrix: enu,
          id: e.pickId,
          attributes: attributes as Record<string, Cesium.GeometryInstanceAttribute>,
        }),
      );
    }
    if (!instances.length) return;
    try {
      this.glyphPrim = this.scene.primitives.add(
        new C.Primitive({
          geometryInstances: instances,
          appearance: new C.PerInstanceColorAppearance({ translucent: true, closed: true, flat: false }),
          asynchronous: false,
          releaseGeometryInstances: true,
          compressVertices: false,
        }),
      );
      (this.glyphPrim as unknown as { _dtOffset: boolean })._dtOffset = offsetSupported;
    } catch (err) {
      console.warn("[deeptrace] glyph primitive failed", err);
      this.glyphPrim = null;
    }
  }

  setShowLabels(v: boolean) {
    this.showLabels = v;
  }

  setHovered(id: string | null) {
    const prev = this.hovered;
    this.hovered = id;
    for (const k of [prev, id]) {
      const e = k ? this.byId.get(k) : undefined;
      if (e && e.vis) this.styleIcon(e, e.vis, performance.now() / 1000);
    }
  }

  setSelected(id: string | null) {
    this.selected = id;
  }

  applyDisplay(model: DisplayModel) {
    this.display = model;
    const t = performance.now() / 1000;
    for (const e of this.entries) {
      const v = model.nodes[e.g.idx];
      if (!v) continue;
      e.vis = v;
      this.styleIcon(e, v, t);
    }
    this.glyphStylesDirty = true;
  }
  private glyphStylesDirty = true;

  private styleIcon(e: NodeEntry, v: NodeVisual, time: number) {
    const C = this.C;
    const show = v.visible && v.alpha > 0.03;
    const deep = this.deepT;
    // underground nodes are understated in surface mode unless they matter right now
    const ghost = e.g.underground ? (1 - deep) * (v.impacted || v.emphasis > 0 ? 0.2 : 1) : 0;
    e.icon.show = show;
    if (show) {
      const hex = rgbToHex(v.rgb);
      const key = iconKey({ type: e.g.node.type, color: hex, tier: e.tier, mark: v.state === "failed" ? "fail" : "none", underground: e.g.underground });
      if (key !== e.iconKey) {
        e.iconKey = key;
        e.icon.setImage(key, nodeIcon({ type: e.g.node.type, color: hex, tier: e.tier, mark: v.state === "failed" ? "fail" : "none", underground: e.g.underground }));
      }
      let a = v.alpha * (1 - ghost * 0.45);
      let s = 1 - ghost * 0.25;
      if (v.pulse === "blink") a *= 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(time * Math.PI * 2 * 0.7));
      if (v.pulse === "fail") s *= 1 + 0.12 * (0.5 + 0.5 * Math.sin(time * Math.PI * 2 * 1.1));
      if (v.emphasis >= 1) s *= 1.12;
      if (v.emphasis >= 2) s *= 1.18;
      if (this.hovered === e.g.id) s *= 1.25;
      e.icon.color = setColor(this.tmpColor, [1, 1, 1], Math.min(1, a));
      e.icon.scale = s;
    }
    const haloRgb = v.halo;
    const haloShow = show && !!haloRgb && v.alpha > 0.3;
    e.halo.show = haloShow;
    if (haloShow && haloRgb) {
      let ha = v.emphasis >= 1 ? 0.75 : 0.5;
      let hs = 1;
      if (v.pulse === "fail" || v.pulse === "alert") {
        const p = 0.5 + 0.5 * Math.sin(time * Math.PI * 2 * (v.pulse === "fail" ? 1.1 : 0.8));
        ha *= 0.55 + 0.45 * p;
        hs = 0.9 + 0.35 * p;
      }
      e.halo.color = setColor(this.tmpColor, haloRgb, ha);
      e.halo.scale = hs * (1 - ghost * 0.3);
    }
    if (e.label) {
      const lab = e.label;
      const labelShow = show && this.showLabels && v.alpha > 0.3 && (!e.g.underground || deep > 0.5 || v.emphasis > 0 || v.impacted);
      (lab as unknown as { _dtWant: boolean })._dtWant = labelShow;
      if (!labelShow) lab.show = false;
      const col = v.impacted ? v.rgb : null;
      lab.fillColor = col ? setColor(this.tmpColor, [0.5 + col[0] * 0.5, 0.5 + col[1] * 0.5, 0.5 + col[2] * 0.5], 1) : setColor(this.tmpColor, [0.9, 0.92, 0.96], 1);
      e.labelPriority = (e.tier === "major" ? 100 : 30) + (e.g.node.critical ? 60 : 0) + (v.impacted ? 200 : 0) + v.emphasis * 300 + (this.selected === e.g.id ? 2000 : 0);
    }
    if (e.drop && e.dropMat) {
      // depth reading aids: always for major subsurface assets, otherwise only when they matter
      const major = e.tier === "major" || e.g.node.type === "utility_vault";
      const dshow = show && deep > 0.02 && (major || v.emphasis > 0 || v.impacted || this.hovered === e.g.id);
      e.drop.show = dshow;
      if (dshow) {
        setColor(e.dropMat.uniforms.color, v.impacted ? v.rgb : [0.62, 0.72, 0.86], (major ? 0.42 : 0.3) * deep * v.alpha);
        setParams(e.dropMat, 0, 0, 1, 0);
        setDash(e.dropMat, 5, 0.45);
      }
    }
  }

  /** Update billboard / label / drop-line / glyph positions after the depth transform changed. */
  updatePositions(deepT: number) {
    const C = this.C;
    this.deepT = deepT;
    for (const e of this.entries) {
      const p = this.iconPosition(e, this.scratch);
      e.icon.position = p;
      e.halo.position = p;
      if (e.label) e.label.position = p;
      if (e.drop) {
        C.Cartesian3.add(e.g.base, C.Cartesian3.multiplyByScalar(e.g.up, 0.6, this.scratch2), this.scratch2);
        e.drop.positions = [this.scratch2, e.g.pos];
      }
      if (e.vis) this.styleIcon(e, e.vis, performance.now() / 1000);
    }
    this.glyphStylesDirty = true;
  }

  iconPosition(e: NodeEntry, out: Cesium.Cartesian3) {
    const C = this.C;
    return C.Cartesian3.add(e.g.pos, C.Cartesian3.multiplyByScalar(e.g.up, e.lift, out), out);
  }

  /** Displayed anchor of a node's icon (for effects, selection, tooltips). */
  anchorOf(id: string, out: Cesium.Cartesian3): Cesium.Cartesian3 | null {
    const e = this.byId.get(id);
    if (!e) return null;
    return this.iconPosition(e, out);
  }

  private updateGlyphAttributes() {
    const prim = this.glyphPrim;
    if (!prim || !this.display) return;
    if (!prim.ready) return;
    this.glyphReady = true;
    const C = this.C;
    const hasOffset = (prim as unknown as { _dtOffset: boolean })._dtOffset;
    for (const e of this.entries) {
      if (!e.glyph) continue;
      const attrs = prim.getGeometryInstanceAttributes(e.pickId);
      if (!attrs) continue;
      const v = e.vis;
      const deep = this.deepT;
      const show = !!v && v.visible && v.alpha > 0.05 && (!e.g.underground || deep > 0.08);
      attrs.show = C.ShowGeometryInstanceAttribute.toValue(show, attrs.show);
      if (!v) continue;
      let a = e.glyph.alpha * v.alpha * (e.g.underground ? smoothstep(0.08, 0.6, deep) : 1);
      if (e.glyph.shape === "disc") a = e.glyph.alpha * (v.impacted ? 2.2 : 1) * v.alpha;
      const c = v.rgb;
      const k = e.glyph.shape === "disc" ? 1 : 0.78;
      attrs.color = C.ColorGeometryInstanceAttribute.toValue(setColor(this.tmpColor, [c[0] * k, c[1] * k, c[2] * k], Math.min(1, a)), attrs.color);
      if (hasOffset && e.g.underground) {
        const off = C.Cartesian3.multiplyByScalar(e.g.up, e.g.rel, this.scratch);
        attrs.offset = C.Cartesian3.pack(off, attrs.offset ?? new Float32Array(3));
      }
    }
  }

  /** Per-frame animation (pulses, selection ring) + deferred glyph work. */
  animate(time: number) {
    const C = this.C;
    if (this.glyphDirty) {
      this.glyphDirty = false;
      this.buildGlyphPrimitive();
      this.glyphStylesDirty = true;
    }
    if (this.glyphStylesDirty || !this.glyphReady) {
      if (this.glyphPrim?.ready) {
        this.glyphStylesDirty = false;
        this.updateGlyphAttributes();
      }
    }
    if (this.display) {
      for (const e of this.entries) {
        const v = e.vis;
        if (v && v.visible && v.pulse !== "none") this.styleIcon(e, v, time);
      }
    }
    // selection pulse
    const sel = this.selected ? this.byId.get(this.selected) : undefined;
    const showSel = !!sel && !!sel.vis?.visible;
    this.selRing.show = showSel;
    this.selRing2.show = showSel;
    this.selReticle.show = showSel;
    if (sel && showSel) {
      const p = this.iconPosition(sel, this.scratch);
      this.selRing.position = p;
      this.selRing2.position = p;
      this.selReticle.position = p;
      const base = (ICON_PX[sel.tier] + 6) / 64;
      const k1 = (time * 0.75) % 1;
      const k2 = (time * 0.75 + 0.5) % 1;
      this.selRing.scale = base * (1.1 + k1 * 1.6);
      this.selRing.color = setColor(this.tmpColor, [0.85, 0.95, 1], 0.9 * (1 - k1));
      this.selRing2.scale = base * (1.1 + k2 * 1.6);
      this.selRing2.color = setColor(this.tmpColor, [0.85, 0.95, 1], 0.9 * (1 - k2));
      this.selReticle.scale = (base * 64) / 52 * 1.55;
      this.selReticle.rotation = 0;
      this.selReticle.color = setColor(this.tmpColor, [1, 1, 1], 0.95);
    }
    void C;
  }

  /** Greedy screen-space label decluttering by priority. */
  declutter() {
    const C = this.C;
    const scene = this.scene;
    const placed: number[][] = [];
    const cands: { e: NodeEntry; x: number; y: number; w: number }[] = [];
    const camPos = scene.camera.positionWC;
    const w = scene.canvas.clientWidth;
    const h = scene.canvas.clientHeight;
    for (const e of this.entries) {
      if (!e.label) continue;
      const want = (e.label as unknown as { _dtWant: boolean })._dtWant;
      if (!want) continue;
      const p = e.label.position;
      const dist = C.Cartesian3.distance(camPos, p);
      if (dist > e.labelFar && (e.vis?.emphasis ?? 0) < 1 && !e.vis?.impacted) {
        e.label.show = false;
        continue;
      }
      const win = C.SceneTransforms.worldToWindowCoordinates(scene, p, new C.Cartesian2());
      if (!win || win.x < -50 || win.y < -50 || win.x > w + 50 || win.y > h + 50) {
        e.label.show = false;
        continue;
      }
      cands.push({ e, x: win.x, y: win.y, w: e.labelW });
    }
    cands.sort((a, b) => b.e.labelPriority - a.e.labelPriority);
    for (const c of cands) {
      const px = ICON_PX[c.e.tier] + 6;
      const scale = c.e.vis && c.e.vis.emphasis > 0 ? 1 : 0.95;
      const x0 = c.x - (c.w * scale) / 2;
      const x1 = c.x + (c.w * scale) / 2;
      const y1 = c.y - px / 2 - 3;
      const y0 = y1 - 21;
      let ok = true;
      for (const r of placed) {
        if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) {
          ok = false;
          break;
        }
      }
      if (ok) placed.push([x0 - 4, y0 - 2, x1 + 4, y1 + 2]);
      c.e.label!.show = ok;
    }
  }

  destroy() {
    for (const c of [this.halos, this.icons, this.labels, this.drops, this.selection]) {
      if (!c.isDestroyed()) this.scene.primitives.remove(c);
    }
    if (this.glyphPrim && !this.glyphPrim.isDestroyed()) this.scene.primitives.remove(this.glyphPrim);
    this.glyphPrim = null;
  }
}
