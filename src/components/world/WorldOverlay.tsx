"use client";
/**
 * Small world-owned overlays: comparison diff legend, Deep Mode depth / strata legend, the
 * "no ion token" notice and the cascade initiation flash. Positioned bottom-left of the free
 * viewport (right of the 300 px left panel column), kept compact so it never collides with
 * the interface panels or the simulation dock.
 */
import { useEffect, useState } from "react";
import { STRATA } from "@/engine/rendering/StrataLayer";
import { DIFF_HEX, rgbToHex } from "@/engine/rendering/palette";
import { useWorldUi } from "@/engine/worldUi";
import { useStore } from "@/lib/store";

function Flash() {
  const flash = useWorldUi((s) => s.flash);
  const [on, setOn] = useState(0);
  useEffect(() => {
    if (!flash) return;
    setOn(flash);
    const t = setTimeout(() => setOn(0), 900);
    return () => clearTimeout(t);
  }, [flash]);
  if (!on) return null;
  return (
    <div
      key={on}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20"
      style={{
        background: "radial-gradient(ellipse at 50% 55%, rgba(244,63,94,0.0) 30%, rgba(244,63,94,0.32) 100%)",
        animation: "dt-flash 0.9s ease-out forwards",
      }}
    />
  );
}

export default function WorldOverlay() {
  const compareView = useStore((s) => s.compareView);
  const hasComparison = useStore((s) => !!s.comparison);
  const deepMode = useStore((s) => s.deepMode);
  const depthScale = useStore((s) => s.depthScale);
  const ws = useStore((s) => s.worldStatus);
  const deepT = useWorldUi((s) => s.deepT);
  const dismissed = useWorldUi((s) => s.noticeDismissed);
  const setUi = useWorldUi((s) => s.set);

  const showDiff = compareView === "diff" && hasComparison;
  const showDeep = deepT > 0.05 || deepMode;
  const showNotice = !dismissed && ws.status !== "loading" && (!ws.ionToken || ws.buildings === "unavailable") && !!ws.message;

  return (
    <>
      <style>{`@keyframes dt-flash{0%{opacity:0}12%{opacity:1}100%{opacity:0}}`}</style>
      <Flash />
      <div className="pointer-events-none absolute bottom-4 left-4 z-10 flex flex-col items-start gap-2 md:left-[316px]">
        {showDeep && (
          <div className="dt-panel pointer-events-auto w-[214px] px-3 py-2.5" style={{ opacity: Math.min(1, 0.25 + deepT), borderRadius: 12 }}>
            <div className="flex items-center justify-between">
              <span className="dt-label">Subsurface</span>
              <span className="dt-num text-[10.5px] text-ink-200">
                depth ×{depthScale.toFixed(depthScale % 1 ? 1 : 0)}
              </span>
            </div>
            <div className="mt-2 flex gap-2.5">
              <div className="relative w-1.5 rounded-full" style={{ background: "linear-gradient(#7dd3fc55, #a78bfa55 55%, #1e1b4b)" }} />
              <ul className="flex-1 space-y-1">
                <li className="flex items-center gap-2 text-[10.5px] text-ink-200">
                  <span className="h-1.5 w-3 rounded-sm border border-sky-300/50" />
                  Surface · 0 m
                </li>
                {STRATA.map((s) => (
                  <li key={s.depth} className="flex items-center gap-2 text-[10.5px] text-ink-200">
                    <span className="h-1.5 w-3 rounded-sm" style={{ background: `${rgbToHex(s.rgb)}aa` }} />
                    <span className="truncate">{s.label}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-2 text-[10px] leading-snug text-ink-400">Depths exaggerated for legibility; geography is exact.</div>
          </div>
        )}
        {showDiff && (
          <div className="dt-panel pointer-events-auto flex items-center gap-3 px-3 py-2" style={{ borderRadius: 12 }}>
            <span className="dt-label">Scenario diff</span>
            {(
              [
                ["Only A", DIFF_HEX.a],
                ["Only B", DIFF_HEX.b],
                ["Both", DIFF_HEX.both],
              ] as const
            ).map(([label, c]) => (
              <span key={label} className="flex items-center gap-1.5 text-[11px] text-ink-100">
                <span className="h-2 w-2 rounded-full" style={{ background: c, boxShadow: `0 0 6px ${c}` }} />
                {label}
              </span>
            ))}
          </div>
        )}
        {showNotice && (
          <div className="dt-panel pointer-events-auto flex max-w-[360px] items-start gap-2 px-3 py-2" style={{ borderRadius: 12 }}>
            <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300/80" />
            <div className="text-[11px] leading-snug text-ink-200">
              <span className="text-ink-100">3D buildings &amp; terrain off.</span> {ws.message}
            </div>
            <button
              type="button"
              onClick={() => setUi({ noticeDismissed: true })}
              className="ml-1 shrink-0 rounded px-1 text-[12px] leading-none text-ink-400 hover:text-ink-100"
              aria-label="Dismiss notice"
            >
              ×
            </button>
          </div>
        )}
      </div>
    </>
  );
}
