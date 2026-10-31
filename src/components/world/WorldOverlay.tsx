"use client";
/**
 * Small world-owned overlays: comparison diff legend, Deep Mode depth / strata legend, the
 * "no ion token" notice and the cascade initiation flash. Anchored bottom-left (left 12 / bottom 12,
 * 288 px wide) in the space the interface keeps free at the foot of the left column.
 */
import { STRATA } from "@/engine/rendering/StrataLayer";
import { DIFF_HEX, rgbToHex } from "@/engine/rendering/palette";
import { useWorldUi } from "@/engine/worldUi";
import { useStore } from "@/lib/store";

function Flash() {
  // keyed by the flash counter: each initiating failure remounts a one-shot CSS animation
  const flash = useWorldUi((s) => s.flash);
  if (!flash) return null;
  return (
    <div
      key={flash}
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
  // the interface keeps the bottom of the left column free for this stack:
  // 112 px normally, 250 px while Deep Mode or the comparison diff is on
  const showNotice = !dismissed && ws.status !== "loading" && (!ws.ionToken || ws.buildings === "unavailable") && !!ws.message;

  return (
    <>
      <style>{`@keyframes dt-flash{0%{opacity:0}12%{opacity:1}100%{opacity:0}}`}</style>
      <Flash />
      <div
        className="pointer-events-none absolute bottom-3 left-3 z-10 flex w-[288px] flex-col items-start justify-end gap-1.5 overflow-hidden"
        style={{ maxHeight: showDeep || showDiff ? 250 : 112 }}
      >
        {showDeep && (
          <div
            className="dt-panel pointer-events-auto w-full px-3 py-2"
            style={{ opacity: Math.min(1, 0.25 + deepT), borderRadius: 12 }}
            title="Depths are exaggerated for legibility; positions are geographically exact."
          >
            <div className="flex items-center justify-between">
              <span className="dt-label">Subsurface strata</span>
              <span className="dt-num text-[10.5px] text-ink-200">depth ×{depthScale.toFixed(depthScale % 1 ? 1 : 0)}</span>
            </div>
            <div className="mt-1.5 flex gap-2.5">
              <div className="w-1 rounded-full" style={{ background: "linear-gradient(#7dd3fc66, #a78bfa66 60%, #312e81aa)" }} />
              <ul className="flex-1 space-y-[3px]">
                <li className="flex items-center gap-2 text-[10.5px] leading-[14px] text-ink-200">
                  <span className="h-1.5 w-3 shrink-0 rounded-sm border border-sky-300/50" />
                  Surface reference grid · 0 m
                </li>
                {STRATA.map((s) => (
                  <li key={s.depth} className="flex items-center gap-2 text-[10.5px] leading-[14px] text-ink-200">
                    <span className="h-1.5 w-3 shrink-0 rounded-sm" style={{ background: `${rgbToHex(s.rgb)}aa` }} />
                    <span className="truncate">{s.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {showDiff && (
          <div className="dt-panel pointer-events-auto flex w-full items-center justify-between gap-2 px-3 py-2" style={{ borderRadius: 12 }}>
            <span className="dt-label">Diff</span>
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
          <div className="dt-panel pointer-events-auto flex w-full items-start gap-2 px-3 py-2" style={{ borderRadius: 12 }}>
            <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300/80" />
            <div className="text-[10.5px] leading-snug text-ink-300">
              <span className="text-ink-100">3D buildings &amp; terrain off.</span> {ws.message}
            </div>
            <button
              type="button"
              onClick={() => setUi({ noticeDismissed: true })}
              className="-mr-1 shrink-0 rounded px-1 text-[13px] leading-none text-ink-400 hover:text-ink-100"
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
