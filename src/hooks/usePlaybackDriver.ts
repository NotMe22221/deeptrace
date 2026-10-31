"use client";
import { useEffect } from "react";
import { useStore } from "@/lib/store";

/** Milliseconds each cascade step stays on screen while playing. */
export const CASCADE_STEP_MS = 1600;

/**
 * Advances the cascade playback while `playback.playing` is true. The world renders
 * whatever `playback.step` says; the timeline UI scrubs the same value.
 */
export function usePlaybackDriver() {
  const playing = useStore((s) => s.playback.playing);
  const step = useStore((s) => s.playback.step);
  const maxStep = useStore((s) => s.playback.maxStep);
  const runId = useStore((s) => s.playback.runId);
  const setPlaybackStep = useStore((s) => s.setPlaybackStep);
  const setPlaying = useStore((s) => s.setPlaying);

  useEffect(() => {
    if (!playing) return;
    if (step >= maxStep) {
      // Hold the final state briefly, then stop.
      const t = setTimeout(() => setPlaying(false), 400);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setPlaybackStep(step + 1), step === 0 ? CASCADE_STEP_MS * 0.8 : CASCADE_STEP_MS);
    return () => clearTimeout(t);
  }, [playing, step, maxStep, runId, setPlaybackStep, setPlaying]);
}
