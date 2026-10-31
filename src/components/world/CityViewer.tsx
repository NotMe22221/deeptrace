"use client";
/**
 * Full-screen 3D world. Loads CesiumJS at runtime, creates the WorldController (guarded against
 * React strict-mode double mounting), registers the WorldApi, and renders the world-owned
 * overlays (hover tooltip, legends / notices, cascade flash).
 */
import { useEffect, useRef, useState } from "react";
import { loadCesium } from "@/engine/geographic/cesiumLoader";
import { registerWorld } from "@/engine/worldBridge";
import type { WorldController } from "@/engine/WorldController";
import { useStore } from "@/lib/store";
import WorldOverlay from "./WorldOverlay";
import WorldTooltip from "./WorldTooltip";

export function CityViewer() {
  const ref = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let ctrl: WorldController | null = null;
    const container = ref.current;
    const fail = (msg: string) => {
      if (disposed) return;
      setFailure(msg);
      useStore.getState().setWorldStatus({ status: "error", message: msg });
    };
    Promise.all([loadCesium(), import("@/engine/WorldController")])
      .then(([C, mod]) => {
        if (disposed || !container) return;
        // strict mode / HMR: never stack two viewers in one container
        container.replaceChildren();
        try {
          ctrl = new mod.WorldController(C, container);
          registerWorld(ctrl.api);
        } catch (e) {
          console.error("[deeptrace] world failed to start", e);
          fail(
            /webgl/i.test(String((e as Error)?.message))
              ? "WebGL is unavailable in this browser, so the 3D world cannot start."
              : `The 3D world failed to start: ${(e as Error)?.message ?? e}`,
          );
        }
      })
      .catch((e) => fail((e as Error)?.message ?? "CesiumJS failed to load"));
    return () => {
      disposed = true;
      if (ctrl) {
        registerWorld(null);
        ctrl.destroy();
        ctrl = null;
      }
    };
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden bg-ink-950">
      <div ref={ref} className="dt-world absolute inset-0" />
      <WorldTooltip />
      <WorldOverlay />
      {failure && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="dt-panel-strong max-w-md px-5 py-4 text-center">
            <div className="dt-label mb-1.5">3D world unavailable</div>
            <p className="text-[13px] leading-relaxed text-ink-200">{failure}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default CityViewer;
