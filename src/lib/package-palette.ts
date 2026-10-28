// The `/` menu's Typst packages section: one group per installed package,
// listing its functions (from the Package reference documentation). Choosing
// one inserts `#name()` with the caret inside, and imports the package above
// the notebox import if the note doesn't yet, so browsing doubles as the way
// to start using a package.
//
// Menu sources are read synchronously when the menu opens, so the packages and
// their documentation are fetched ahead of time: once a notebox has finished
// indexing (so the work doesn't compete with it), and when packages are
// installed or removed (`inkycap:packages-changed`).

import { createEffect, createSignal, onCleanup } from "solid-js";
import type { EditorView } from "@codemirror/view";
import * as ipc from "./ipc";
import { t } from "./i18n";
import { registerPaletteSource } from "../editor/typst-decorations/palette-registry";
import type { PaletteItem } from "../editor/typst-decorations/command-palette";
import { expandFunc } from "../editor/typst-decorations/effects";
import { editAsApp } from "../editor/app-edit";
import { indexReady, noteboxInfo } from "../stores/notebox";
import { activeNotePath } from "../stores/tabs";
import { showToast, toastError } from "../stores/toasts";

/** Sent after packages are installed, removed or created. */
export const PACKAGES_CHANGED_EVENT = "inkycap:packages-changed";

interface PackageFunctions {
  pkg: ipc.InstalledPackageEntry;
  functions: string[];
}

let loaded: PackageFunctions[] = [];
let generation = 0;
/** What the open note imports, so its own packages are listed first. Read from
 *  disk, and added to when this menu adds an import. */
let imported = new Set<string>();

async function refresh(): Promise<void> {
  const mine = ++generation;
  let packages: ipc.InstalledPackageEntry[];
  try {
    packages = await ipc.listInstalledPackages();
  } catch {
    packages = [];
  }
  const next: PackageFunctions[] = [];
  // One at a time: each asks Tinymist to read a whole package.
  for (const pkg of packages) {
    try {
      const docs = await ipc.getPackageDocs(pkg.spec);
      const functions = docs.symbols.filter((s) => s.kind === "function").map((s) => s.name);
      if (functions.length > 0) next.push({ pkg, functions });
    } catch {
      // A package Tinymist can't read is left out of the menu.
    }
    if (mine !== generation) return;
  }
  loaded = next;
}

function insertFunction(view: EditorView, name: string, pkg: ipc.InstalledPackageEntry): void {
  const from = view.state.selection.main.from;
  const call = `#${name}()`;
  view.dispatch({
    changes: { from, insert: call },
    selection: { anchor: from + call.length - 1 },
    // Keep the call's source showing so the caret stays inside its brackets.
    effects: expandFunc.of(from),
  });
  view.focus();
  // The import goes above InkyCap's own, which the visual editor hides, so say
  // when one was added.
  editAsApp(view, (text) => ipc.addPackageToSource(text, pkg.spec))
    .then((added) => {
      if (!added) return;
      imported.add(pkg.spec);
      showToast("info", t("slash.packageAdded", { name: pkg.name }));
    })
    .catch((err) => toastError(t("slash.packageImportFailed"), err));
}

function paletteItems(): PaletteItem[] {
  // The note's own packages first. A function one of them already provides
  // (some packages pass on others' functions) isn't offered again from a
  // package that would need adding.
  const own = loaded.filter(({ pkg }) => imported.has(pkg.spec));
  const others = loaded.filter(({ pkg }) => !imported.has(pkg.spec));
  const available = new Set(own.flatMap(({ functions }) => functions));
  const groups = [
    ...own.map((entry) => ({ entry, functions: entry.functions, adds: false })),
    ...others.map((entry) => ({
      entry,
      functions: entry.functions.filter((name) => !available.has(name)),
      adds: true,
    })),
  ];
  return groups
    .filter(({ functions }) => functions.length > 0)
    .map(({ entry: { pkg }, functions, adds }) => ({
      label: `${pkg.name} ${pkg.version}`,
      category: "Packages",
      submenu: functions.map((name) => ({
        label: name,
        category: "Packages",
        shortcut: adds ? t("slash.packageToAdd", { name: pkg.name }) : pkg.name,
        indent: true,
        action: (view: EditorView) => insertFunction(view, name, pkg),
      })),
    }));
}

/** Add the packages section to the `/` menu and keep it current. Call once at
 *  startup, inside a reactive owner. */
export function registerPackagePalette(): void {
  registerPaletteSource("typst-packages", paletteItems);
  createEffect(() => {
    if (noteboxInfo() && indexReady()) void refresh();
    else loaded = [];
  });
  const onChanged = () => void refresh();
  document.addEventListener(PACKAGES_CHANGED_EVENT, onChanged);
  onCleanup(() => document.removeEventListener(PACKAGES_CHANGED_EVENT, onChanged));

  // Follow the open note's imports.
  const [saved, setSaved] = createSignal(0);
  const onSaved = () => setSaved((n) => n + 1);
  document.addEventListener("inkycap:note-saved", onSaved);
  onCleanup(() => document.removeEventListener("inkycap:note-saved", onSaved));
  createEffect(() => {
    const path = activeNotePath();
    saved();
    if (!path) {
      imported = new Set();
      return;
    }
    ipc.listNotePackageImports(path).then(
      (specs) => {
        if (activeNotePath() === path) imported = new Set(specs);
      },
      () => {},
    );
  });
}
