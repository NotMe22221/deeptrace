/**
 * Imperative bridge between the interface and the 3D world.
 *
 * State that the world renders (layers, deep mode, selection, simulation results...) flows
 * through the zustand store. One-shot camera commands do not belong in state, so the world
 * controller registers this API when the viewer is ready and the interface calls it.
 * Every method must be safe to call before the world is ready (it is then a no-op).
 */
export interface WorldApi {
  /** Fly to the region's default overview camera. */
  flyHome(opts?: { duration?: number }): void;
  /** Fly to frame a node. */
  flyToNode(nodeId: string, opts?: { duration?: number; range?: number }): void;
  /** Fly to frame a set of nodes (e.g. a cascade footprint). */
  flyToNodes(nodeIds: string[], opts?: { duration?: number }): void;
  /** Cinematic move to the oblique underground exploration view used by Deep Mode. */
  flyToDeepView(opts?: { duration?: number }): void;
  /** Slow automatic orbit around the current focus point. */
  setOrbit(enabled: boolean): void;
  isOrbiting(): boolean;
  zoom(direction: 1 | -1): void;
  resetNorth(): void;
  /** Adjust camera pitch by delta degrees. */
  tilt(deltaDeg: number): void;
}

let current: WorldApi | null = null;
const listeners = new Set<(api: WorldApi | null) => void>();

export function registerWorld(api: WorldApi | null) {
  current = api;
  listeners.forEach((l) => l(api));
}

export function onWorldChange(cb: (api: WorldApi | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

const noop = () => {};

/** Always returns an object; methods no-op until the world registers. */
export function world(): WorldApi {
  return (
    current ?? {
      flyHome: noop,
      flyToNode: noop,
      flyToNodes: noop,
      flyToDeepView: noop,
      setOrbit: noop,
      isOrbiting: () => false,
      zoom: noop,
      resetNorth: noop,
      tilt: noop,
    }
  );
}
