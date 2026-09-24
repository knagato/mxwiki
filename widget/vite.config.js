import { defineConfig } from "vite";

// Static build: one HTML + hashed assets in widget/dist (not committed). Serve
// it from any static host; see docs/DEPLOY.md for headers and caching.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: "assets/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" } },
  },
  server: { port: 5180 },
});
