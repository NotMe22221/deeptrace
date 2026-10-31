"use client";
import { BookOpenCheck, Check, ExternalLink, Minus, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { fmtDate, fmtNum } from "@/lib/format";
import { LAYER_ORDER, PROVENANCE_STYLES, SYSTEM_STYLES } from "@/lib/systems";
import { useNetworkStats } from "@/hooks/useNetworkStats";
import { PROVENANCE_CATEGORIES, type ProvenanceCategory } from "@/types/infrastructure";
import { closePanel } from "./actions";
import { ProvenanceBar } from "./LayerPanel";
import { cx, IconButton, ProvenanceChip, SectionLabel } from "./ui";

const TREATMENT: Record<ProvenanceCategory, string> = {
  verified: "Solid line, full opacity.",
  publicly_mapped: "Solid line, slightly dimmed.",
  estimated: "Dashed line / soft halo.",
  simulated: "Hatched or dotted, lower opacity — always labelled SIMULATED.",
};

function Swatch({ category }: { category: ProvenanceCategory }) {
  const c = PROVENANCE_STYLES[category].color;
  return (
    <span className="relative flex h-5 w-9 shrink-0 items-center justify-center rounded-md border border-white/[0.06] bg-black/20">
      {category === "verified" && <span className="h-[2px] w-6 rounded-full" style={{ background: c }} />}
      {category === "publicly_mapped" && <span className="h-[2px] w-6 rounded-full opacity-80" style={{ background: c }} />}
      {category === "estimated" && <span className="w-6 border-t-2 border-dashed" style={{ borderColor: c }} />}
      {category === "simulated" && <span className="dt-hatch h-2 w-6 rounded-[2px] border border-dashed" style={{ borderColor: `${c}aa` }} />}
    </span>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-t border-white/[0.06] px-4 py-3 first:border-0">
      <SectionLabel className="mb-2" right={right}>
        {title}
      </SectionLabel>
      {children}
    </section>
  );
}

export function ProvenancePanel() {
  const network = useStore((s) => s.network);
  const worldStatus = useStore((s) => s.worldStatus);
  const dataMode = useStore((s) => s.dataMode);
  const snapshot = useStore((s) => s.snapshot);
  const stats = useNetworkStats();
  const usesCarto = /carto/i.test(worldStatus.imagery ?? "");
  const total = stats ? PROVENANCE_CATEGORIES.reduce((a, c) => a + stats.provenanceTotals[c], 0) : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-white/[0.07] pr-1.5 pl-3.5">
        <BookOpenCheck className="size-4 text-ink-300" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[12.5px] font-semibold tracking-[0.12em] text-ink-50 uppercase">Data provenance</h2>
          <div className="truncate text-[10.5px] leading-tight text-ink-300">What is real, what is mapped, what is modelled</div>
        </div>
        <IconButton label="Close provenance" shortcut="P" size="sm" onClick={() => closePanel("provenance")}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="dt-scroll min-h-0 flex-1 overflow-y-auto">
        <Section title="Four categories">
          <ul className="space-y-2.5">
            {PROVENANCE_CATEGORIES.map((c) => {
              const p = PROVENANCE_STYLES[c];
              const n = stats?.provenanceTotals[c] ?? 0;
              return (
                <li key={c} className="flex gap-2.5">
                  <Swatch category={c} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <ProvenanceChip category={c} />
                      <span className="text-[12px] font-medium text-ink-50">{p.label}</span>
                      <span className="dt-num ml-auto text-[11px] text-ink-300">
                        {fmtNum(n, 0)}
                        {total ? <span className="text-ink-500"> · {Math.round((n / total) * 100)}%</span> : null}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11.5px] leading-snug text-ink-300">{p.description}</p>
                    <p className="text-[10.5px] text-ink-400">On the map: {TREATMENT[c]}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>

        {stats && (
          <Section title="By system" right={<span className="dt-num text-[10px] text-ink-400">nodes + links</span>}>
            <div className="space-y-2">
              {LAYER_ORDER.map((k) => {
                const s = stats.bySystem[k];
                const t = PROVENANCE_CATEGORIES.reduce((a, c) => a + s.provenance[c], 0);
                if (!t) return null;
                return (
                  <div key={k}>
                    <div className="flex items-baseline justify-between text-[11.5px]">
                      <span className="flex items-center gap-1.5 text-ink-100">
                        <span className="size-1.5 rounded-full" style={{ background: SYSTEM_STYLES[k].color }} />
                        {SYSTEM_STYLES[k].label}
                      </span>
                      <span className="dt-num text-[10px] text-ink-400">
                        {PROVENANCE_CATEGORIES.filter((c) => s.provenance[c])
                          .map((c) => `${PROVENANCE_STYLES[c].short.slice(0, 3)} ${s.provenance[c]}`)
                          .join(" · ")}
                      </span>
                    </div>
                    <ProvenanceBar provenance={s.provenance} className="mt-1" height={5} />
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {network && network.datasets.length > 0 && (
          <Section title="Datasets" right={<span className="dt-num text-[10px] text-ink-400">{network.datasets.length}</span>}>
            <ul className="space-y-2">
              {network.datasets.map((d) => (
                <li key={d.id} className={cx("rounded-lg border px-2.5 py-2", d.category === "simulated" ? "dt-hatch border-dashed border-white/12" : "border-white/[0.07] bg-white/[0.02]")}>
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1 text-[12px] font-medium text-ink-50">{d.name}</span>
                    <ProvenanceChip category={d.category} />
                  </div>
                  <div className="mt-1 text-[11px] leading-snug text-ink-300">
                    {d.source_url && /^https?:\/\//.test(d.source_url) ? (
                      <a href={d.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sky-200/90 hover:text-sky-100">
                        {d.source}
                        <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      d.source
                    )}
                  </div>
                  <dl className="dt-num mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-[2px] text-[10.5px]">
                    <dt className="text-ink-400">License</dt>
                    <dd className="text-ink-200">{d.license ?? "—"}</dd>
                    <dt className="text-ink-400">Retrieved</dt>
                    <dd className="text-ink-200">{fmtDate(d.retrieved_at)}</dd>
                    <dt className="text-ink-400">Features</dt>
                    <dd className="text-ink-200">{fmtNum(d.feature_count, 0)}</dd>
                    <dt className="text-ink-400">Inspected</dt>
                    <dd className="flex items-center gap-1 text-ink-200">
                      {d.inspected ? <Check className="size-3 text-ok" /> : <Minus className="size-3 text-ink-400" />}
                      {d.inspected ? "Yes — checked by the pipeline" : "No"}
                    </dd>
                    {d.systems.length > 0 && (
                      <>
                        <dt className="text-ink-400">Systems</dt>
                        <dd className="flex flex-wrap gap-1.5 text-ink-200">
                          {d.systems.map((s) => (
                            <span key={s} className="inline-flex items-center gap-1">
                              <span className="size-1.5 rounded-full" style={{ background: SYSTEM_STYLES[s]?.color }} />
                              {SYSTEM_STYLES[s]?.label ?? s}
                            </span>
                          ))}
                        </dd>
                      </>
                    )}
                  </dl>
                  {d.notes && <p className="mt-1.5 text-[11px] leading-snug text-ink-300">{d.notes}</p>}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {network && network.assumptions.length > 0 && (
          <Section title="Network assumptions">
            <ul className="list-disc space-y-1 pl-4 text-[11.5px] leading-snug text-ink-200 marker:text-ink-500">
              {network.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Limitations">
          <div className="rounded-lg border border-warn/25 bg-warn/[0.05] px-3 py-2 text-[11.5px] leading-relaxed text-ink-200">
            <p>
              This build ships an <span className="font-medium text-ink-50">illustrative network</span>. Real utility routes,
              capacities and interconnections are not public, so buried power, water and telecom assets are{" "}
              <span className="font-medium text-ink-50">simulated</span> along public street corridors and anchored to publicly
              mapped landmarks.
            </p>
            <p className="mt-1.5">
              Simulation results are modelled outcomes for exploration and discussion — not validated engineering predictions.
            </p>
            <p className="mt-1.5 text-ink-300">
              Data mode:{" "}
              {dataMode === "live"
                ? "live engine"
                : dataMode === "snapshot"
                  ? `offline snapshot${snapshot ? ` (engine v${snapshot.engine_version}, ${fmtDate(snapshot.generated_at)})` : " — network only"}`
                  : dataMode}
              {network && ` · network ${network.id} v${network.version}`}
            </p>
          </div>
        </Section>

        <Section title="Attributions">
          <ul className="space-y-1.5 text-[11.5px] leading-snug text-ink-200">
            <li>
              © <span className="text-ink-50">OpenStreetMap contributors</span> — street network, landmarks and 3D buildings, licensed
              under the Open Database License (ODbL).
            </li>
            <li>
              <span className="text-ink-50">CesiumJS</span> (Apache-2.0) 3D globe renderer
              {worldStatus.buildings === "ion-osm" || worldStatus.terrain === "ion-world" ? (
                <>
                  ; <span className="text-ink-50">Cesium ion</span> — Cesium OSM Buildings
                  {worldStatus.terrain === "ion-world" ? " and Cesium World Terrain" : ""}.
                </>
              ) : (
                <span className="text-ink-400"> · Cesium ion content not loaded in this session.</span>
              )}
            </li>
            <li className={usesCarto ? undefined : "text-ink-400"}>
              <span className={usesCarto ? "text-ink-50" : undefined}>CARTO</span> basemap tiles
              {usesCarto ? " — © CARTO, map data © OpenStreetMap contributors." : " — not used in this session."}
            </li>
            <li className="text-ink-400">Fonts: Inter, Space Grotesk, JetBrains Mono (OFL). Icons: Lucide (ISC).</li>
          </ul>
        </Section>
      </div>
    </div>
  );
}
