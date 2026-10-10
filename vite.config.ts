import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Viewer only: reads static data from public/data/ (written by `pnpm analyze`). Hash routing + relative base
// so a build can be served from any sub-path.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { port: 5173 },
  build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 900 },
});
