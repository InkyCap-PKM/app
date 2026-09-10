// A Vite plugin that loads `.wasm` modules in Vitest, used in place of
// vite-plugin-wasm while tests run.
//
// vite-plugin-wasm instantiates every wasm module through one shared helper
// that it provides as a *virtual* module. Vitest's module runner turns a
// virtual id into `file:///__vite-plugin-wasm-helper` and hands that to Node's
// `fileURLToPath`, which on Windows rejects a file URL with no drive letter,
// so every suite that reaches the Typst parser fails to load before a test
// runs. (Linux and macOS accept the odd path, which is why CI is unaffected.)
//
// This plugin generates the instantiation inline for each wasm file instead,
// so the only module ids involved are real files. It handles the shape
// wasm-bindgen's bundler target emits: the wasm module imports its glue
// functions from a sibling `.js` file and is imported as an ES module whose
// exports are the wasm exports. The generated module reads the bytes from
// disk, instantiates with the glue modules the wasm names, and re-exports each
// export by name. Top-level await keeps the ES-module semantics vite-plugin-wasm
// gives the same import in the app.
//
// Test-only by design: the app itself keeps vite-plugin-wasm.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export default function vitestWasmLoader(): Plugin {
  return {
    name: "inkycap:vitest-wasm-loader",
    enforce: "pre",

    load(id) {
      if (!id.endsWith(".wasm")) return null;
      const file = id.split("?")[0];
      const bytes = readFileSync(file);
      const module = new WebAssembly.Module(bytes);

      // One namespace import per module the wasm imports from, resolved
      // relative to the wasm file so the id is a real path.
      const importModules = [...new Set(WebAssembly.Module.imports(module).map((i) => i.module))];
      const importLines = importModules.map((name, i) => {
        const resolved = name.startsWith(".") ? path.resolve(path.dirname(file), name) : name;
        return `import * as __imports${i} from ${JSON.stringify(resolved)};`;
      });
      const importObject = importModules
        .map((name, i) => `${JSON.stringify(name)}: __imports${i}`)
        .join(", ");

      const exportLines = WebAssembly.Module.exports(module).map(({ name }) => {
        if (!IDENTIFIER.test(name)) {
          throw new Error(`wasm export ${JSON.stringify(name)} in ${file} is not a valid identifier`);
        }
        return `export const ${name} = __instance.exports[${JSON.stringify(name)}];`;
      });

      return [
        ...importLines,
        `import { readFileSync as __read } from "node:fs";`,
        `const __result = await WebAssembly.instantiate(__read(${JSON.stringify(file)}), { ${importObject} });`,
        `const __instance = __result.instance;`,
        ...exportLines,
      ].join("\n");
    },
  };
}
