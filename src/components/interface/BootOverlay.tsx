"use client";
import { Check, CircleAlert, RotateCw } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { BrandMark } from "./BrandMark";
import { Button, cx, Spinner } from "./ui";

/** Longest we hold the curtain for the 3D world once the data is ready. */
const WORLD_GRACE_MS = 7000;

type LineState = "pending" | "active" | "done" | "warn";

function Line({ state, label, detail }: { state: LineState; label: string; detail?: string }) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex size-4 items-center justify-center">
        {state === "done" ? (
          <Check className="size-3.5 text-ok" />
        ) : state === "warn" ? (
          <span className="size-1.5 rounded-full bg-[#e9c46a]" />
        ) : state === "active" ? (
          <Spinner className="size-3.5 text-ink-100" />
        ) : (
          <span className="size-1 rounded-full bg-ink-500" />
        )}
      </span>
      <span className={cx("text-[12.5px]", state === "pending" ? "text-ink-400" : "text-ink-100")}>{label}</span>
      {detail && <span className="dt-num ml-auto text-[10.5px] text-ink-400">{detail}</span>}
    </li>
  );
}

export function BootOverlay() {
  const dataMode = useStore((s) => s.dataMode);
  const dataError = useStore((s) => s.dataError);
  const network = useStore((s) => s.network);
  const health = useStore((s) => s.health);
  const ws = useStore((s) => s.worldStatus);
  const bootstrap = useStore((s) => s.bootstrap);
  const [graceOver, setGraceOver] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const dataReady = dataMode === "live" || dataMode === "snapshot";
  const worldReady = ws.status !== "loading";

  useEffect(() => {
    if (!dataReady) return;
    const t = window.setTimeout(() => setGraceOver(true), WORLD_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [dataReady]);

  useEffect(() => {
    if (!dataReady || !(worldReady || graceOver)) return;
    const t = window.setTimeout(() => setDismissed(true), 650);
    return () => window.clearTimeout(t);
  }, [dataReady, worldReady, graceOver]);

  const visible = dataMode === "error" || !dismissed;

  const geo: LineState = worldReady ? (ws.status === "error" ? "warn" : "done") : "active";
  const graph: LineState = network ? "done" : dataMode === "error" ? "warn" : "active";
  const engine: LineState =
    dataMode === "live"
      ? "done"
      : dataMode === "snapshot"
        ? "warn"
        : dataMode === "error"
          ? "warn"
          : network
            ? "active"
            : "pending";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="boot"
          role={dataMode === "error" ? "alertdialog" : "status"}
          aria-label={dataMode === "error" ? "DEEPTRACE could not start" : "Loading DEEPTRACE"}
          className="fixed inset-0 z-[90] flex items-center justify-center bg-ink-950"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.8, ease: "easeInOut" } }}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_42%,rgba(34,211,238,0.06),transparent_55%)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-[linear-gradient(90deg,transparent,rgba(148,163,184,0.12),transparent)]"
          />
          <motion.div
            className="relative w-[min(420px,calc(100vw-32px))]"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          >
            <div className="flex flex-col items-center text-center">
              <BrandMark size={44} />
              <div className="mt-4 font-display text-[22px] font-semibold tracking-[0.42em] text-ink-50">DEEPTRACE</div>
              <div className="mt-1.5 text-[12.5px] text-ink-300">See the systems that make our world work</div>
            </div>

            {dataMode === "error" ? (
              <div className="mt-8 rounded-xl border border-alert/25 bg-alert/[0.05] p-4">
                <div className="flex items-center gap-2 text-[13px] font-medium text-[#fecdd3]">
                  <CircleAlert className="size-4" />
                  No engine and no offline snapshot found
                </div>
                {dataError && <p className="mt-1 font-mono text-[11px] text-ink-300">{dataError}</p>}
                <p className="mt-3 text-[12px] text-ink-200">Start the simulation engine:</p>
                <pre className="mt-1 overflow-x-auto rounded-md border border-white/[0.07] bg-black/40 px-2.5 py-2 font-mono text-[11px] text-ink-100">
                  cd backend && .venv/bin/uvicorn app.main:app --port 8000
                </pre>
                <p className="mt-2.5 text-[12px] text-ink-200">
                  …or export the offline snapshot (no server needed afterwards):
                </p>
                <pre className="mt-1 overflow-x-auto rounded-md border border-white/[0.07] bg-black/40 px-2.5 py-2 font-mono text-[11px] text-ink-100">
                  make snapshot
                </pre>
                <p className="mt-1.5 text-[11px] text-ink-400">
                  Runs <code className="font-mono">app.scripts.export_snapshot</code>, writing public/demo/network.json
                  and public/demo/snapshot.json. Then press Retry.
                </p>
                <div className="mt-3 flex justify-end">
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<RotateCw className="size-3.5" />}
                    onClick={() => void bootstrap()}
                  >
                    Retry
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <ul className="mt-9 space-y-2.5">
                  <Line
                    state={geo}
                    label="Loading geographic environment…"
                    detail={
                      worldReady
                        ? ws.buildings === "ion-osm"
                          ? "3D buildings"
                          : "globe"
                        : graceOver
                          ? "continuing"
                          : undefined
                    }
                  />
                  <Line
                    state={graph}
                    label="Building infrastructure graph…"
                    detail={network ? `${network.nodes.length} nodes · ${network.edges.length} links` : undefined}
                  />
                  <Line
                    state={engine}
                    label="Connecting simulation engine…"
                    detail={
                      dataMode === "live"
                        ? `live · v${health?.version ?? "?"}`
                        : dataMode === "snapshot"
                          ? "offline snapshot"
                          : undefined
                    }
                  />
                </ul>
                <div className="relative mt-7 h-px overflow-hidden bg-white/[0.06]">
                  <div className="animate-scan absolute inset-y-0 w-1/3 bg-[linear-gradient(90deg,transparent,rgba(226,232,240,0.7),transparent)]" />
                </div>
                {network?.region && (
                  <p className="dt-num mt-3 text-center text-[10px] tracking-[0.16em] text-ink-400 uppercase">
                    {network.region.name} · {network.region.center[0].toFixed(3)}°,{" "}
                    {network.region.center[1].toFixed(3)}°
                  </p>
                )}
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
