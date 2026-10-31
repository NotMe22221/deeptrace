"use client";
import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useStore } from "@/lib/store";
import { Interface } from "@/components/interface/Interface";

// The 3D world is client-only (CesiumJS) and sits full-screen behind the interface.
const CityViewer = dynamic(() => import("@/components/world/CityViewer"), { ssr: false });

export default function DeeptraceApp() {
  const bootstrap = useStore((s) => s.bootstrap);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
  return (
    <main className="fixed inset-0 overflow-hidden bg-ink-950">
      <div className="absolute inset-0 z-0">
        <CityViewer />
      </div>
      <Interface />
    </main>
  );
}
