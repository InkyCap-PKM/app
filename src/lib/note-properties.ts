// The set of property keys a note can carry, as the Properties panel presents
// them. Shared so the panel, the search box's `property:` completions, and any
// later surface all offer the same list.

/**
 * The `#note(...)` fields InkyCap defines itself, in the order the Properties
 * panel lists them. Anything else a notebox uses is a custom property.
 */
export const KNOWN_PROPERTY_KEYS = [
  "title", "aliases", "description", "tags", "date", "due",
  "task", "disposition", "source", "zid", "collection",
];

export const KNOWN_PROPERTY_KEY_SET = new Set(KNOWN_PROPERTY_KEYS);

/**
 * The notebox's property keys, ordered the way the Properties panel shows
 * them: the built-in fields first in their canonical order, then whatever
 * custom keys the notebox uses, alphabetically.
 *
 * `all` is the raw list from `get_all_property_keys`, which appends the
 * `file.*` pseudo-properties (`file.ctime`, `file.size`, …) for the collection
 * column picker. Those aren't `#note(...)` fields — no note declares one and
 * the search `property:` filter never matches one — so they're dropped here.
 */
export function notePropertyKeys(all: string[]): string[] {
  const custom = all
    .filter((key) => !key.startsWith("file.") && !KNOWN_PROPERTY_KEY_SET.has(key))
    .sort();
  return [...KNOWN_PROPERTY_KEYS, ...custom];
}
