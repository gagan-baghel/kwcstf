import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // In development the FastAPI app runs separately on :8000.
    proxy: { "/api": "http://localhost:8000" },
  },
  build: {
    // Vendor code changes rarely: separate chunks stay cached across app deploys.
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes("node_modules") ? (/recharts|d3-|victory/.test(id) ? "charts" : "vendor") : undefined),
      },
    },
  },
});
