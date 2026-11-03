import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Cesium is served from /public/cesium and loaded at runtime (see src/engine/geographic/cesiumLoader.ts).
  poweredByHeader: false,
};

export default nextConfig;
