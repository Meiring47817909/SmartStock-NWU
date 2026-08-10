import type { NextConfig } from "next";

// Note: the service worker is built separately via Serwist's "configurator
// mode" (see serwist.config.js + the `serwist build` step in package.json).
// That mode is bundler-agnostic and works with Turbopack, which Next 16
// uses by default for both `next dev` and `next build` — the older
// `withSerwistInit` webpack wrapper does not support Turbopack.
const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
