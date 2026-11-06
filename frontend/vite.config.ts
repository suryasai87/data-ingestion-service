/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Monolith build: emit into ../app/static so FastAPI serves the bundle (/_app hashed assets + SPA fallback).
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const apiPort = env.API_PORT ?? "8044";
// DEV_USER=<email>: the proxy sends it as the identity header (the API trusts it only when IDENTITY_MODE=header).
const devUser = env.DEV_USER;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "../app/static", emptyOutDir: true, chunkSizeWarningLimit: 1200, assetsDir: "_app" },
  server: {
    port: 5173,
    proxy: { "/api": { target: `http://localhost:${apiPort}`, headers: devUser ? { "x-forwarded-email": devUser } : undefined } },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    testTimeout: 15000,
  },
});
