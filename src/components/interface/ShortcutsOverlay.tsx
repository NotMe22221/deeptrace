"use client";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";
import { useStore } from "@/lib/store";
import { IconButton, Kbd } from "./ui";
import { useUI } from "./uiStore";

export const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["⌘", "K"], label: "Search components & commands" },
  { keys: ["/"], label: "Search" },
  { keys: ["D"], label: "Toggle Deep Mode" },
  { keys: ["H"], label: "Fly home" },
  { keys: ["L"], label: "Infrastructure layers" },
  { keys: ["S"], label: "Simulation center" },
  { keys: ["A"], label: "AI analyst" },
  { keys: ["C"], label: "Compare scenarios" },
  { keys: ["P"], label: "Data provenance" },
  { keys: ["Space"], label: "Play / pause cascade" },
  { keys: ["←", "→"], label: "Demo: previous / next step" },
  { keys: ["Esc"], label: "Close top panel / clear selection" },
  { keys: ["?"], label: "This overlay" },
];

export function ShortcutsOverlay() {
  const open = useUI((s) => s.shortcutsOpen);
  const setOpen = useUI((s) => s.setShortcutsOpen);
  const ref = useRef<HTMLDivElement>(null);
  // Modal focus, as in the command palette: on open focus the dialog and remember the control that had
  // keyboard focus; while open keep focus inside; once it closes (Esc, ?, Close, a backdrop click) give
  // focus back to that control, unless focus already moved somewhere on purpose. A control focused by a
  // pointer press is not handed focus back. The command palette (Ctrl/Cmd+K still opens it from here)
  // keeps its own focus while it is open.
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    const prev = document.activeElement;
    const opener =
      prev instanceof HTMLElement && prev !== document.body && !dialog?.contains(prev) && prev.matches(":focus-visible")
        ? prev
        : null;
    dialog?.focus();
    const keepInside = (e: FocusEvent) => {
      if (!useUI.getState().shortcutsOpen || useStore.getState().panels.search) return;
      if (dialog && e.target instanceof Node && !dialog.contains(e.target)) dialog.focus();
    };
    document.addEventListener("focusin", keepInside);
    return () => {
      document.removeEventListener("focusin", keepInside);
      const now = document.activeElement;
      if (opener?.isConnected && (!now || now === document.body || dialog?.contains(now)))
        opener.focus({ preventScroll: true });
    };
  }, [open]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[85] flex items-center justify-center bg-ink-950/50 px-4 backdrop-blur-[2px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <motion.div
            ref={ref}
            tabIndex={-1}
            style={{ outline: "none" }}
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            onKeyDown={(e) => {
              // aria-modal: Tab / Shift+Tab stay in the overlay (Close is its only control).
              if (e.key === "Tab") {
                e.preventDefault();
                e.currentTarget.querySelector<HTMLElement>("button")?.focus();
              }
            }}
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.14 }}
            className="dt-panel-strong w-full max-w-[440px] p-1 focus:outline-none"
          >
            <div className="flex items-center justify-between px-3 pt-2 pb-1">
              <h2 className="font-display text-[12.5px] font-semibold tracking-[0.12em] text-ink-50 uppercase">
                Keyboard shortcuts
              </h2>
              <IconButton label="Close" size="sm" onClick={() => setOpen(false)}>
                <X className="size-4" />
              </IconButton>
            </div>
            <ul className="grid grid-cols-1 gap-x-4 px-3 pb-3 sm:grid-cols-1">
              {SHORTCUTS.map((s) => (
                <li
                  key={s.label}
                  className="flex items-center justify-between border-b border-white/[0.05] py-[7px] last:border-0"
                >
                  <span className="text-[12.5px] text-ink-200">{s.label}</span>
                  <span className="flex gap-1">
                    {s.keys.map((k) => (
                      <Kbd key={k} className="min-w-[22px]">
                        {k}
                      </Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
            <p className="px-3 pb-2.5 text-[10.5px] text-ink-400">Shortcuts are ignored while typing in a field.</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
