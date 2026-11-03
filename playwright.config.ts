import { defineConfig } from "@playwright/test";

// End-to-end tests run the built site plus a local PeerServer, so multiplayer
// can be tested without touching the public PeerJS server.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    channel: process.env.PW_CHANNEL ?? "chrome",
    headless: true,
    // Software WebGL so the 3D view renders in headless test browsers.
    launchOptions: { args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"] },
  },
  webServer: [
    { command: "npx vite preview --host 127.0.0.1 --port 4173 --strictPort", url: "http://127.0.0.1:4173", reuseExistingServer: true },
    { command: "node scripts/peer-server.mjs", url: "http://127.0.0.1:9000/", reuseExistingServer: true },
  ],
});
