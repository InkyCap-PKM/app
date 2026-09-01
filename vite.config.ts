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
      // Don't watch the Rust crate or the packaging build trees. The flatpak
      // builder (scripts/build-flatpak.sh) leaves `flatpak/.build` and
      // `.flatpak-builder/` in the repo — both gitignored, but vite's watcher
      // doesn't read .gitignore. Those trees contain sandbox artifacts with
      // symlink loops (e.g. `flatpak/.build/var/run/udev/watch/`); chokidar's
      // `stat` hits ELOOP, throws an uncaught exception, and kills the dev
      // server — leaving the Tauri window blank because `beforeDevCommand`
      // never serves.
      //
      // A predicate (not a glob) is deliberate: picomatch's `**` does not
      // match dot-prefixed segments, so `**/flatpak/**` would silently fail to
      // exclude the `.build` dot-directory and the loop would still bite. This
      // matches any path with one of these dirs as a segment, on either
      // separator.
      ignored: (filePath) =>
        /(?:^|[/\\])(?:src-tauri|flatpak|\.flatpak-builder)(?:[/\\]|$)/.test(
          filePath,
        ),
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
    // `codemirror-lang-typst` ships a `.wasm` parser. Inlining it routes the
    // import through `vite-plugin-wasm` so Vite transforms the `.wasm` module;
    // otherwise Vitest externalizes the dep and Node's ESM loader rejects the
    // unknown `.wasm` extension, failing every suite that touches the parser.
    server: { deps: { inline: [/solid-js/, /@solid-primitives\//, /codemirror-lang-typst/] } },
  },
});
