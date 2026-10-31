/**
 * Loads CesiumJS at runtime from the static build copied to /public/cesium
 * (see scripts/copy-cesium.mjs). Types come from the `cesium` npm package.
 */
import type * as CesiumNS from "cesium";

export type CesiumModule = typeof CesiumNS;

declare global {
  interface Window {
    Cesium?: CesiumModule;
    CESIUM_BASE_URL?: string;
  }
}

let loading: Promise<CesiumModule> | null = null;

export function loadCesium(): Promise<CesiumModule> {
  if (typeof window === "undefined") return Promise.reject(new Error("Cesium can only load in the browser"));
  if (window.Cesium) return Promise.resolve(window.Cesium);
  if (loading) return loading;
  loading = new Promise<CesiumModule>((resolve, reject) => {
    window.CESIUM_BASE_URL = "/cesium/";
    if (!document.querySelector('link[data-cesium-css]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/cesium/Widgets/widgets.css";
      link.dataset.cesiumCss = "1";
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = "/cesium/Cesium.js";
    script.async = true;
    script.onload = () => (window.Cesium ? resolve(window.Cesium) : reject(new Error("CesiumJS loaded but window.Cesium missing")));
    script.onerror = () => {
      loading = null;
      reject(new Error("Failed to load CesiumJS from /cesium/Cesium.js — run `npm install` (postinstall copies Cesium)."));
    };
    document.head.appendChild(script);
  });
  return loading;
}
