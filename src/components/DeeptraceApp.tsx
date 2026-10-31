"use client";
import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useStore } from "@/lib/store";

const CityViewer = dynamic(() => import("@/components/world/CityViewer"), { ssr: false });

export default function DeeptraceApp() {
  const bootstrap = useStore((s) => s.bootstrap);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
  return (
    <main className="fixed inset-0 overflow-hidden bg-ink-950">
      <CityViewer />
    </main>
  );
}
