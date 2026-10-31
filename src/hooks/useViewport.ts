"use client";
import { useSyncExternalStore } from "react";

function subscribe(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

const getW = () => window.innerWidth;
const getH = () => window.innerHeight;
const serverW = () => 1600;
const serverH = () => 900;

export interface Viewport {
  width: number;
  height: number;
  /** Phones / very small windows: panels become bottom sheets. */
  narrow: boolean;
  /** Laptop-sized windows: side panels get tighter, labels drop to icons. */
  compact: boolean;
  /** Large desktop: toolbar shows labels. */
  wide: boolean;
}

export function useViewport(): Viewport {
  const width = useSyncExternalStore(subscribe, getW, serverW);
  const height = useSyncExternalStore(subscribe, getH, serverH);
  return { width, height, narrow: width < 768, compact: width < 1440, wide: width >= 1536 };
}
