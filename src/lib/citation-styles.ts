// Citation styles: the shortlist InkyCap offers in Settings, in a collection's
// Appearance tab and in the bibliography pill, and the full list of styles
// built into Typst, read once from the backend.

import * as ipc from "./ipc";
import type { CitationStyleInfo } from "./types";

/** The shortlist. Style names are proper names and stay as written; the
 *  "custom" entry is a translatable label, resolved by `citationStyleOptions`. */
export const CITATION_STYLES: { value: string; label?: string; labelKey?: string }[] = [
  { value: "chicago-author-date", label: "Chicago (Author-Date)" },
  { value: "chicago-notes", label: "Chicago (Notes)" },
  { value: "apa", label: "APA" },
  { value: "mla", label: "MLA" },
  { value: "ieee", label: "IEEE" },
  { value: "association-for-computing-machinery", label: "ACM" },
  { value: "american-chemical-society", label: "ACS" },
  { value: "american-institute-of-physics", label: "AIP" },
  { value: "american-medical-association", label: "AMA" },
  { value: "american-psychological-association", label: "APA (7th)" },
  { value: "future-medicine", label: "Future Medicine" },
  { value: "gb-7714-2005-numeric", label: "GB/T 7714 (Numeric)" },
  { value: "custom", labelKey: "settings.citations.customCsl.label" },
];

/** The shortlist as select options, with translatable labels resolved
 *  through the caller's `t`. */
export function citationStyleOptions(t: (key: string) => string): { value: string; label: string }[] {
  return CITATION_STYLES.map((s) => ({
    value: s.value,
    label: s.labelKey ? t(s.labelKey) : (s.label ?? s.value),
  }));
}

/** The shortlist's label for a style name, or null when it isn't on the
 *  shortlist. */
export function shortlistLabel(name: string): string | null {
  return CITATION_STYLES.find((s) => s.value === name && s.label)?.label ?? null;
}

let allStyles: Promise<CitationStyleInfo[]> | null = null;

/** Every citation style built into Typst. Read from the backend once; the list
 *  only changes with a new version of InkyCap. */
export function loadCitationStyles(): Promise<CitationStyleInfo[]> {
  if (!allStyles) {
    allStyles = ipc.listCitationStyles().catch((err) => {
      allStyles = null;
      throw err;
    });
  }
  return allStyles;
}

/** Whether `style` names a `.csl` file rather than a built-in style. */
export function isCslPath(style: string): boolean {
  return style.toLowerCase().endsWith(".csl");
}
