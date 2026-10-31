"use client";
// TEMPORARY smoke-test viewer (replaced by the world engine).
import { useEffect, useRef } from "react";
import { loadCesium } from "@/engine/geographic/cesiumLoader";

export default function CityViewer() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let destroyed = false;
    let viewer: { destroy: () => void } | null = null;
    loadCesium().then((Cesium) => {
      if (destroyed || !ref.current) return;
      const v = new Cesium.Viewer(ref.current, {
        baseLayer: false,
        baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
        navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
      });
      v.scene.globe.baseColor = Cesium.Color.fromCssColorString("#0a101d");
      v.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(-84.39, 33.735, 2500), orientation: { pitch: Cesium.Math.toRadians(-35) } });
      v.entities.add({ polyline: { positions: Cesium.Cartesian3.fromDegreesArray([-84.40, 33.75, -84.38, 33.76]), width: 6, material: new Cesium.PolylineGlowMaterialProperty({ color: Cesium.Color.CYAN, glowPower: 0.3 }) } });
      (window as unknown as { __viewer: unknown }).__viewer = v;
      viewer = v;
    });
    return () => { destroyed = true; viewer?.destroy(); };
  }, []);
  return <div ref={ref} className="absolute inset-0" />;
}
