// Matching for wikilink `[[ ]]` suggestions.
//
// Stricter than quick open's `fuzzyMatch`: the query must appear in a
// candidate's words as written, as one case-insensitive substring or, for
// several words, each word as a substring. So a query like "asd dthe" doesn't
// match every note containing those letters in order, and exact or prefix hits
// (e.g. "cirfa" → "CIRFA") rank first.

/**
 * Score how well `query` matches `target` (a note name or alias): `null` for no
 * match, higher is better. An empty query matches everything equally, so a bare
 * `[[` lists all notes.
 */
export function wikilinkScore(query: string, target: string): number | null {
  const q = query.toLowerCase().trim();
  if (q === "") return 0;
  const t = target.toLowerCase();

  // Whole-string exact match wins outright.
  if (t === q) return 10000;

  const idx = t.indexOf(q);
  if (idx >= 0) {
    // Contiguous substring. Rank prefix > word-start > mid-word; a shorter
    // (more specific) target and an earlier position break ties.
    const atStart = idx === 0;
    const atWordStart = idx > 0 && "/-_ ".includes(t[idx - 1]);
    const base = atStart ? 5000 : atWordStart ? 3000 : 1000;
    return base - target.length - idx;
  }

  // Several words: each must appear as a substring, in any order ("digital
  // humanities" → "Alliance of Digital Humanities Organizations").
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((tok) => t.includes(tok))) {
    return 500 - target.length;
  }

  return null;
}
