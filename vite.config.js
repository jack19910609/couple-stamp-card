import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_ACTIONS ? "/couple-stamp-card/" : "/",
  test: {
    environment: "node",
    include: ["src/**/*.test.js"],
  },
});
