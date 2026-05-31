// Matching for wikilink `[[ ]]` suggestions.
//
// Deliberately stricter than the quick-open `fuzzyMatch` (a loose subsequence
// scorer): a wikilink query must match the *letters as they appear in the
// words* of a candidate — a contiguous, case-insensitive substring, or, for a
// multi-word query, every whitespace-separated token as a substring. This
// stops a nonsense query like "asd dthe" from dragging in every note whose
// letters merely appear in that order, and keeps an exact/prefix hit (e.g.
// "cirfa" → "CIRFA") ranked at the top.

/**
 * Score how well `query` matches a wikilink candidate `target` (a note name or
 * alias). Returns `null` when it doesn't match at all; higher is a better
 * match. An empty query matches everything with a neutral score, so typing a
 * bare `[[` lists all notes.
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

  // Multi-token query: every whitespace-separated token must appear as a
  // contiguous substring (order-independent). Covers "digital humanities" →
  // "Alliance of Digital Humanities Organizations".
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((tok) => t.includes(tok))) {
    return 500 - target.length;
  }

  return null;
}
