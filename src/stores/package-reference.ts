// Which package the right sidebar's package reference shows when one is
// chosen for the open note (from the Templates panel or the Properties pane)
// rather than taken from its imports. The choice belongs to that note and is
// dropped when another opens (see `clearChosenPackage`).

import { createSignal } from "solid-js";
import { normalizePath, pathEquals } from "../lib/paths";
import { setRightCollapsed, setRightPanelTab } from "./layout";
import { activeNotePath } from "./tabs";

/** The right-panel tab id of the package reference. */
export const PACKAGE_REFERENCE_TAB = "package-reference";

const [chosen, setChosen] = createSignal<{ spec: string; notePath: string | null } | null>(null);

/** The package chosen for the note at `path`, or null. */
export function chosenPackageFor(path: string | undefined): string | null {
  const c = chosen();
  return c && path && pathEquals(c.notePath, path) ? c.spec : null;
}

/** Forget the chosen package, when another note opens. */
export function clearChosenPackage(): void {
  setChosen(null);
}

/** Show `spec`'s reference in the right sidebar beside the open note, opening
 *  the sidebar if collapsed. */
export function showPackageReference(spec: string): void {
  setChosen({ spec, notePath: activeNotePath() ?? null });
  setRightPanelTab(PACKAGE_REFERENCE_TAB);
  setRightCollapsed(false);
}

/** The package (`@ns/name:version`) whose folder holds the file at `path`, or
 *  null when it isn't inside an installed package. */
export function packageSpecOfFile(path: string): string | null {
  const m = /\/\.inkycap\/packages\/([^/]+)\/([^/]+)\/([^/]+)\//.exec(normalizePath(path));
  return m ? `@${m[1]}/${m[2]}:${m[3]}` : null;
}

/** Whether `path` is a scaffold (`.inkycap/scaffolds/`). */
export function isScaffoldFile(path: string): boolean {
  return normalizePath(path).includes("/.inkycap/scaffolds/");
}

/** Whether `path` belongs to a package or is a scaffold: files managed in the
 *  Templates pane rather than notes. */
export function isPackageOrScaffoldFile(path: string): boolean {
  return packageSpecOfFile(path) !== null || isScaffoldFile(path);
}
