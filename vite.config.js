import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",
      injectRegister: false,
      registerType: "prompt",
      // Keep the existing hand-written manifest: it already owns the product
      // name, standalone display mode and iOS installation metadata.
      manifest: false,
      includeAssets: ["manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"],
    }),
  ],
  base: process.env.GITHUB_ACTIONS ? "/couple-stamp-card/" : "/",
  test: {
    environment: "node",
    include: ["src/**/*.test.js"],
  },
});
