/**
 * Living networks: glowing sprites that travel along physical edges in the flow direction.
 * Per-system motion comes from SYSTEM_STYLES.particle (speed m/s, spacing m, size px); density
 * scales with utilisation; hard cap of MAX_PARTICLES. Positions are interpolated each frame from
 * the precomputed cumulative-length arrays of the displayed polylines (O(particles) per frame).
 *
 * Also renders TRACE PULSES: bright sprites running along trace.source_paths toward the sources.
 */
import type * as Cesium from "cesium";
import type { CesiumModule } from "@/engine/geographic/cesiumLoader";
import { lerp } from "@/engine/geographic/LocalFrame";
import { SYSTEM_STYLES } from "@/lib/systems";
import type { DisplayModel } from "./displayState";
import { glowSprite } from "./icons";
import type { EdgeGeom, NetworkGeometry } from "./NetworkGeometry";
import { setColor, type RGB } from "./palette";

export const MAX_PARTICLES = 2000;

interface Particle {
  e: EdgeGeom;
  s0: number;
  speed: number;
  bb: Cesium.Billboard;
  flicker: number;
}

interface PathSeg {
  e: EdgeGeom;
  reversed: boolean;
  start: number;
}

interface TracePath {
  segs: PathSeg[];
  length: number;
}

export class ParticleSystem {
  private readonly C: CesiumModule;
  private readonly scene: Cesium.Scene;
  readonly collection: Cesium.BillboardCollection;
  readonly pulses: Cesium.BillboardCollection;
  private pool: Cesium.Billboard[] = [];
  private particles: Particle[] = [];
  private paths: TracePath[] = [];
  private pulsePool: Cesium.Billboard[] = [];
  private readonly scratch: Cesium.Cartesian3;
  private readonly tmpColor: Cesium.Color;
  private geom: NetworkGeometry | null = null;

  constructor(C: CesiumModule, scene: Cesium.Scene) {
    this.C = C;
    this.scene = scene;
    this.collection = scene.primitives.add(new C.BillboardCollection({ scene }));
    this.pulses = scene.primitives.add(new C.BillboardCollection({ scene }));
    this.scratch = new C.Cartesian3();
    this.tmpColor = new C.Color();
  }

  private take(i: number): Cesium.Billboard {
    let bb = this.pool[i];
    if (!bb) {
      bb = this.collection.add({
        image: glowSprite("dot"),
        width: 16,
        height: 16,
        show: false,
        position: this.C.Cartesian3.ZERO,
        scaleByDistance: new this.C.NearFarScalar(250, 1.15, 6000, 0.45),
      });
      this.pool[i] = bb;
    }
    return bb;
  }

  /** Rebuild particle assignment from the display model. */
  rebuild(geom: NetworkGeometry, model: DisplayModel, deepT: number, enabled: boolean) {
    this.geom = geom;
    this.particles = [];
    let used = 0;
    if (enabled) {
      type Want = { e: EdgeGeom; count: number; dir: 1 | -1; twoWay: boolean; speed: number; size: number; rgb: RGB; alpha: number; packet: boolean };
      const wants: Want[] = [];
      let total = 0;
      for (const e of geom.edges) {
        const v = model.edges[e.idx];
        if (!v.visible || !v.flow || v.alpha < 0.25) continue;
        const sys = SYSTEM_STYLES[e.edge.infrastructure_type];
        const pp = sys?.particle;
        if (!pp || pp.speed <= 0 || pp.spacing <= 0) continue;
        const ghost = e.cls === "buried" ? (1 - deepT) * (v.trace !== "none" ? 0.2 : 1) : 0;
        const count = Math.max(1, Math.min(40, Math.round((e.length / pp.spacing) * (0.45 + 0.9 * v.flow.utilization))));
        if (e.length < 12) continue;
        total += count;
        wants.push({
          e,
          count,
          dir: v.flow.dir,
          twoWay: v.flow.twoWay,
          speed: pp.speed * v.flow.speedMul * (0.85 + 0.3 * v.flow.utilization),
          size: pp.size * v.flow.sizeMul * lerp(1, 0.72, ghost),
          rgb: v.flow.rgb,
          alpha: v.flow.alpha * Math.min(1, v.alpha + 0.1) * lerp(1, 0.5, ghost),
          packet: e.edge.infrastructure_type === "telecom",
        });
      }
      const k = total > MAX_PARTICLES ? MAX_PARTICLES / total : 1;
      for (const w of wants) {
        const n = Math.max(1, Math.floor(w.count * k));
        for (let i = 0; i < n && used < MAX_PARTICLES; i++) {
          const bb = this.take(used++);
          const dir = w.twoWay && i % 2 ? -w.dir : w.dir;
          bb.show = true;
          bb.setImage(w.packet ? "glow|packet" : "glow|dot", glowSprite(w.packet ? "packet" : "dot"));
          const px = w.size * 2.3;
          bb.width = px;
          bb.height = px;
          bb.color = setColor(this.tmpColor, w.rgb, w.alpha);
          this.particles.push({
            e: w.e,
            s0: (i / n) * w.e.length + Math.random() * (w.e.length / n) * 0.35,
            speed: w.speed * dir,
            bb,
            flicker: w.e.edge.infrastructure_type === "power" ? 1 : 0,
          });
        }
      }
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].show = false;
  }

  /** Trace pulses along source paths (node-id or edge-id sequences). */
  setTrace(geom: NetworkGeometry, startNode: string | null, sourcePaths: string[][] | null) {
    this.paths = [];
    if (startNode && sourcePaths?.length) {
      const adj = new Map<string, EdgeGeom[]>();
      for (const e of geom.edges) {
        for (const nid of [e.edge.source_node, e.edge.target_node]) {
          const arr = adj.get(nid) ?? [];
          arr.push(e);
          adj.set(nid, arr);
        }
      }
      for (const raw of sourcePaths.slice(0, 8)) {
        if (!raw || raw.length < 2) continue;
        const isEdges = raw.every((id) => geom.edgeIndex.has(id)) && !raw.some((id) => geom.nodeIndex.has(id));
        const segs: PathSeg[] = [];
        let cur = isEdges ? startNode : raw[0];
        let acc = 0;
        if (isEdges) {
          for (const id of raw) {
            const e = geom.edges[geom.edgeIndex.get(id)!];
            const reversed = e.edge.target_node === cur;
            segs.push({ e, reversed, start: acc });
            acc += e.length;
            cur = reversed ? e.edge.source_node : e.edge.target_node;
          }
        } else {
          let nodes = raw;
          // paths may be stored source -> node; pulses always travel from the traced node toward the source
          if (nodes[nodes.length - 1] === startNode && nodes[0] !== startNode) nodes = [...nodes].reverse();
          cur = nodes[0];
          for (let i = 1; i < nodes.length; i++) {
            const nxt = nodes[i];
            const cands = (adj.get(cur) ?? []).filter((e) => (e.edge.source_node === cur && e.edge.target_node === nxt) || (e.edge.target_node === cur && e.edge.source_node === nxt));
            const e = cands.find((c) => c.cls !== "dependency") ?? cands[0];
            if (e) {
              const reversed = e.edge.target_node === cur;
              segs.push({ e, reversed, start: acc });
              acc += e.length;
            }
            cur = nxt;
          }
        }
        if (segs.length) this.paths.push({ segs, length: acc });
      }
    }
    // allocate pulse sprites: 3 per path
    const need = this.paths.length * 3;
    for (let i = 0; i < Math.max(need, this.pulsePool.length); i++) {
      if (i >= this.pulsePool.length) {
        this.pulsePool.push(
          this.pulses.add({
            image: glowSprite("flare"),
            width: 30,
            height: 30,
            show: false,
            position: this.C.Cartesian3.ZERO,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new this.C.NearFarScalar(250, 1.2, 6000, 0.55),
          }),
        );
      }
      this.pulsePool[i].show = i < need;
    }
  }

  update(time: number) {
    const geom = this.geom;
    if (!geom) return;
    const out = this.scratch;
    for (const p of this.particles) {
      const L = p.e.length;
      let s = (p.s0 + p.speed * time) % L;
      if (s < 0) s += L;
      geom.pointAlong(p.e, s, out);
      p.bb.position = out;
      if (p.flicker) {
        // energy pulses: brief brightening as they travel
        const f = 0.82 + 0.18 * Math.sin(time * 9 + p.s0);
        p.bb.scale = f;
      }
    }
    // trace pulses
    let k = 0;
    for (const path of this.paths) {
      for (let j = 0; j < 3; j++) {
        const bb = this.pulsePool[k++];
        if (!bb) continue;
        const speed = Math.max(140, path.length / 3.2);
        const d = ((time * speed + (j * path.length) / 3) % path.length + path.length) % path.length;
        let seg = path.segs[0];
        for (const sg of path.segs) if (sg.start <= d) seg = sg;
        const local = d - seg.start;
        geom.pointAlong(seg.e, seg.reversed ? seg.e.length - local : local, out);
        bb.position = out;
        const fade = Math.min(1, d / 40, (path.length - d) / 40);
        bb.color = setColor(this.tmpColor, [1, 0.97, 0.9], 0.95 * Math.max(0, fade));
      }
    }
  }

  setVisible(v: boolean) {
    this.collection.show = v;
  }

  destroy() {
    for (const c of [this.collection, this.pulses]) if (!c.isDestroyed()) this.scene.primitives.remove(c);
  }
}
