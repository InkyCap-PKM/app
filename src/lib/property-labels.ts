// Display labels for collection property keys. Collection tables use raw keys:
// note properties (`title`, `instructor`, …) and file properties (`file.mtime`,
// `file.size`, …). The `file.*` keys get readable labels here, for display
// only; the key is still what sorting, filtering, column settings and IPC use.
// Note property names are shown as written.

import { t } from "./i18n";

/** Known synthetic filesystem property keys, in a sensible display order. */
export const FILE_PROPERTY_KEYS = [
  "file.name",
  "file.folder",
  "file.path",
  "file.ext",
  "file.size",
  "file.ctime",
  "file.mtime",
  "file.links",
  "file.backlinks",
] as const;

/**
 * Human-friendly label for a collection property key. `file.*` keys map to
 * their i18n label; any other key (user-authored note property) is returned
 * unchanged.
 */
export function propertyLabel(key: string): string {
  if (key.startsWith("file.")) {
    // i18n keys mirror the property key: "property.file.mtime" → "Modified".
    const translated = t(`property.${key}`);
    // t() returns the key itself when a string is missing; fall back to the
    // raw property key so an unmapped file.* property still reads sensibly.
    return translated === `property.${key}` ? key : translated;
  }
  return key;
}
