/**
 * Mouse interaction: throttled hover picking (~30 Hz) -> store.setHovered + pointer cursor +
 * tooltip position; click selects nodes / edges; double-click flies to them. Particle and effect
 * collections are hidden during the pick pass so sprites never steal the pointer.
 */
import type * as Cesium from "cesium";
import type { CesiumModule } from "@/engine/geographic/cesiumLoader";
import type { PickId } from "@/engine/rendering/EdgeRenderer";

export interface PickHandlers {
  hover: (id: PickId | null, pointer: { x: number; y: number } | null) => void;
  click: (id: PickId) => void;
  doubleClick: (id: PickId) => void;
  /** collections that must not intercept picks */
  transient: () => { show: boolean }[];
}

const isPickId = (v: unknown): v is PickId =>
  !!v && typeof v === "object" && "dt" in (v as object) && "id" in (v as object) && typeof (v as PickId).id === "string";

export class PickController {
  private readonly C: CesiumModule;
  private readonly scene: Cesium.Scene;
  private readonly handler: Cesium.ScreenSpaceEventHandler;
  private readonly h: PickHandlers;
  private pending: Cesium.Cartesian2 | null = null;
  private lastPick = 0;
  private timer: number | null = null;
  private buttons = 0;
  private hovered: PickId | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(C: CesiumModule, viewer: Cesium.Viewer, handlers: PickHandlers) {
    this.C = C;
    this.scene = viewer.scene;
    this.h = handlers;
    // our own interaction model: no entity tracking / selection
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_CLICK);
    this.handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
    this.handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      this.pending = C.Cartesian2.clone(m.endPosition);
      this.schedule();
    }, C.ScreenSpaceEventType.MOUSE_MOVE);
    this.handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const id = this.pick(e.position);
      if (id) this.h.click(id);
    }, C.ScreenSpaceEventType.LEFT_CLICK);
    this.handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const id = this.pick(e.position);
      if (id) this.h.doubleClick(id);
    }, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    const canvas = viewer.scene.canvas;
    const down = (ev: PointerEvent) => (this.buttons = ev.buttons);
    const up = (ev: PointerEvent) => (this.buttons = ev.buttons);
    const leave = () => {
      this.pending = null;
      this.setHover(null, null);
    };
    canvas.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    canvas.addEventListener("pointerleave", leave);
    this.cleanup.push(() => {
      canvas.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointerleave", leave);
    });
  }

  private schedule() {
    if (this.timer !== null) return;
    const wait = Math.max(0, 33 - (performance.now() - this.lastPick));
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.lastPick = performance.now();
      const p = this.pending;
      if (!p) return;
      if (this.buttons) {
        // dragging the camera: don't pick, hide tooltip
        this.setHover(null, null);
        return;
      }
      const id = this.pick(p);
      this.setHover(id, id ? { x: p.x, y: p.y } : null);
    }, wait);
  }

  private setHover(id: PickId | null, pointer: { x: number; y: number } | null) {
    const changed = (id?.id ?? null) !== (this.hovered?.id ?? null);
    this.hovered = id;
    this.scene.canvas.style.cursor = id ? "pointer" : "";
    if (changed || id) this.h.hover(id, pointer);
  }

  pick(pos: Cesium.Cartesian2): PickId | null {
    const hidden: { show: boolean }[] = [];
    for (const c of this.h.transient()) {
      if (c.show) {
        c.show = false;
        hidden.push(c);
      }
    }
    try {
      const picked = this.scene.pick(pos, 9, 9) as { id?: unknown; primitive?: unknown } | undefined;
      const id = picked?.id;
      if (isPickId(id)) return id;
      return null;
    } catch {
      return null;
    } finally {
      for (const c of hidden) c.show = true;
    }
  }

  destroy() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.cleanup.forEach((f) => f());
    if (!this.handler.isDestroyed()) this.handler.destroy();
    void this.C;
  }
}
