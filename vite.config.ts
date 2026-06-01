/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import wasm from "vite-plugin-wasm";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [wasm(), solid()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    // jsdom gives module code a `document` (i18n `setLocale` sets `<html
    // lang/dir>`). Solid's test condition resolves the dev build of solid-js.
    environment: "jsdom",
    // Polyfills jsdom's missing layout geometry (Range/Element getClientRects)
    // so CodeMirror popup positioning no-ops instead of throwing in a deferred
    // rAF callback. See src/test-setup.ts.
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    server: { deps: { inline: [/solid-js/, /@solid-primitives\//] } },
  },
});
