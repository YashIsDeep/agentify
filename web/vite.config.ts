import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 2712,
    strictPort: true,
    // Keep the browser's Host/Origin (localhost:2712) so the API's localhost guard accepts them.
    proxy: { "/api": { target: "http://127.0.0.1:2711", changeOrigin: false } },
  },
  // Served from localhost only, so a single ~500 kB bundle is fine.
  build: { chunkSizeWarningLimit: 1024 },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
