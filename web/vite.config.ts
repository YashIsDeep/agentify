import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 2712,
    strictPort: true,
    // Started with --host, the dev UI can be opened from a phone; tailscale serve sends its tailnet name.
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:2711",
        // Keep the browser's Host/Origin (localhost:2712) so the API's localhost guard accepts them.
        changeOrigin: false,
        // And say who connected: without X-Forwarded-For, any device reaching Vite would look like this computer.
        xfwd: true,
      },
    },
  },
  // Served from localhost only, so a single ~500 kB bundle is fine.
  build: { chunkSizeWarningLimit: 1024 },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // The design-system test reads stylesheets as ?raw text; without this Vitest hands back "".
    css: { include: [/.+/] },
  },
});
