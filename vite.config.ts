import { rmSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin copies .dev.vars (the local OpenRouter key) into dist/<worker>/ so `vite preview` can use it.
// Strip it from every build so dist/ never holds the key; `pnpm preview` sets KEEP_DEV_VARS=1 to keep it locally.
const stripDevVars = (): Plugin => ({
  name: "strip-dev-vars",
  apply: "build",
  enforce: "post",
  writeBundle(options) {
    if (!process.env.KEEP_DEV_VARS && options.dir) rmSync(join(options.dir, ".dev.vars"), { force: true });
  },
});

// Viewer (React) + Worker (worker/, config in wrangler.jsonc) together: `pnpm dev` runs the Worker, its Durable
// Objects, local D1 and R2 in workerd next to the Vite dev server. The viewer reads static benchmark data from
// public/data/ (written by `pnpm analyze`) and live/community data from /api/*. Relative base so a build can also be
// served from any sub-path.
export default defineConfig({
  plugins: [react(), cloudflare(), stripDevVars()],
  base: "./",
  server: { port: 5173 },
  build: { outDir: "dist", target: "es2022", chunkSizeWarningLimit: 900 },
});
