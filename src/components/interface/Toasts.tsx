"use client";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "@/lib/store";
import { cx } from "./ui";
import { useUI, type Toast } from "./uiStore";

const TONES: Record<Toast["tone"], { Icon: typeof Info; color: string }> = {
  info: { Icon: Info, color: "#7dd3fc" },
  success: { Icon: CircleCheck, color: "#4ade80" },
  warning: { Icon: TriangleAlert, color: "#e9c46a" },
  error: { Icon: CircleAlert, color: "#f43f5e" },
};

function ToastCard({ t, onClose, persistent }: { t: Toast; onClose: () => void; persistent?: boolean }) {
  const { Icon, color } = TONES[t.tone];
  return (
    <motion.div
      layout
      role={t.tone === "error" ? "alert" : "status"}
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, transition: { duration: 0.15 } }}
      transition={{ duration: 0.18 }}
      className={cx(
        "dt-panel-strong pointer-events-auto flex w-[340px] max-w-full gap-2.5 px-3 py-2.5",
        persistent && "border-alert/30",
      )}
    >
      <Icon className="mt-[1px] size-4 shrink-0" style={{ color }} />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-ink-50">{t.title}</div>
        {t.body && <div className="mt-0.5 text-[11.5px] leading-snug text-ink-300">{t.body}</div>}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="-mt-0.5 -mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-ink-400 hover:bg-white/[0.07] hover:text-ink-50"
      >
        <X className="size-3.5" />
      </button>
    </motion.div>
  );
}

/** Transient notices + the (persistent until dismissed) simulation error. */
export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  const simError = useStore((s) => s.simError);
  return (
    <div aria-live="polite" className="pointer-events-none flex flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {simError && (
          <ToastCard
            key="sim-error"
            persistent
            t={{ id: "sim-error", tone: "error", title: "Could not complete the request", body: simError }}
            onClose={() =>
              useStore.setState((s) => ({
                simError: null,
                simStatus: s.simStatus === "error" ? "idle" : s.simStatus,
                compareStatus: s.compareStatus === "error" ? "idle" : s.compareStatus,
              }))
            }
          />
        )}
        {toasts.map((t) => (
          <ToastCard key={t.id} t={t} onClose={() => dismiss(t.id)} />
        ))}
      </AnimatePresence>
    </div>
  );
}
