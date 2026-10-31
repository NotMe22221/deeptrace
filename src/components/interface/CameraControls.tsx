"use client";
import { ArrowDownToLine, ChevronDown, ChevronUp, Compass, House, Minus, Orbit, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { onWorldChange, world } from "@/engine/worldBridge";
import { useStore } from "@/lib/store";
import { IconButton } from "./ui";

/** Small vertical camera cluster (bottom-right). */
export function CameraControls() {
  const [orbiting, setOrbiting] = useState(false);
  const demoActive = useStore((s) => s.demo.active);

  // Orbit can also be started by the demo / restore; poll the world state cheaply.
  useEffect(() => {
    const sync = () => setOrbiting(world().isOrbiting());
    const unsub = onWorldChange(sync);
    const t = window.setInterval(sync, 800);
    return () => {
      unsub();
      window.clearInterval(t);
    };
  }, [demoActive]);

  const btn = "rounded-md";
  return (
    <div role="toolbar" aria-label="Camera" aria-orientation="vertical" className="dt-panel pointer-events-auto flex w-10 flex-col items-center gap-0.5 py-1">
      <IconButton label="Home view" shortcut="H" tooltipSide="left" size="sm" className={btn} onClick={() => world().flyHome()}>
        <House className="size-4" />
      </IconButton>
      <span className="my-0.5 h-px w-5 bg-white/[0.08]" />
      <IconButton label="Zoom in" tooltipSide="left" size="sm" className={btn} onClick={() => world().zoom(1)}>
        <Plus className="size-4" />
      </IconButton>
      <IconButton label="Zoom out" tooltipSide="left" size="sm" className={btn} onClick={() => world().zoom(-1)}>
        <Minus className="size-4" />
      </IconButton>
      <span className="my-0.5 h-px w-5 bg-white/[0.08]" />
      <IconButton label="Tilt up (towards horizon)" tooltipSide="left" size="sm" className={btn} onClick={() => world().tilt(8)}>
        <ChevronUp className="size-4" />
      </IconButton>
      <IconButton label="Tilt down (towards top-down)" tooltipSide="left" size="sm" className={btn} onClick={() => world().tilt(-8)}>
        <ChevronDown className="size-4" />
      </IconButton>
      <IconButton label="Reset north" tooltipSide="left" size="sm" className={btn} onClick={() => world().resetNorth()}>
        <Compass className="size-4" />
      </IconButton>
      <span className="my-0.5 h-px w-5 bg-white/[0.08]" />
      <IconButton
        label={orbiting ? "Stop orbit" : "Orbit around the view"}
        tooltipSide="left"
        size="sm"
        className={btn}
        pressed={orbiting}
        tone="accent"
        onClick={() => {
          const v = !world().isOrbiting();
          world().setOrbit(v);
          setOrbiting(v);
        }}
      >
        <Orbit className="size-4" />
      </IconButton>
      <IconButton
        label="Deep view (oblique underground camera)"
        tooltipSide="left"
        size="sm"
        className={btn}
        onClick={() => world().flyToDeepView()}
      >
        <ArrowDownToLine className="size-4" />
      </IconButton>
    </div>
  );
}
