// Friendly display labels for collection property keys.
//
// Collection tables key off raw property identifiers — user-authored note
// properties (`title`, `instructor`, …) and synthetic filesystem properties
// (`file.mtime`, `file.size`, …). The raw `file.*` keys are precise but read
// like internals; this module maps them to human labels for display only.
//
// The KEY stays the identity used for sorting, filtering, column config and
// IPC — only the rendered text changes. User-authored property keys are shown
// verbatim (we don't second-guess names the author chose).

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
