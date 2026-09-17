import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import wasm from "vite-plugin-wasm";
import path from "path";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  base: "./",
  plugins: [wasm(), solid({ hot: false })],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../../src") } },
  build: { outDir: "dist", emptyOutDir: true, target: "esnext", minify: false },
});
