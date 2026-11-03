import { defineConfig } from "vite";

// A relative base makes the build work on GitHub Pages under any repo name
// (https://<user>.github.io/<repo>/) and on any other static host.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
    // The 3D view (Three.js) is a separate, lazily loaded chunk of ~140 KB gzipped.
    chunkSizeWarningLimit: 700,
  },
  worker: {
    format: "es",
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
