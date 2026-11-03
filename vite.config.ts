import { defineConfig } from "vite";

// A relative base makes the build work on GitHub Pages under any repo name
// (https://<user>.github.io/<repo>/) and on any other static host.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
