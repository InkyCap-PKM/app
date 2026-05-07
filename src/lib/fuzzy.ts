// Simple fuzzy match scoring for quick-open file search.
// Returns null if no match, otherwise a score and the matched character ranges.

export interface FuzzyMatch {
  /** Higher is better. */
  score: number;
  /** Character index ranges that matched (for highlighting). */
  ranges: [number, number][];
}

/**
 * Score how well `query` fuzzy-matches `target`.
 * Consecutive matches are weighted higher. Case-insensitive.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, ranges: [] };

  const queryLower = query.toLowerCase();
  const targetLower = target.toLowerCase();

  let qi = 0; // query index
  let score = 0;
  let consecutiveBonus = 0;
  const ranges: [number, number][] = [];
  let rangeStart = -1;

  for (let ti = 0; ti < targetLower.length && qi < queryLower.length; ti++) {
    if (targetLower[ti] === queryLower[qi]) {
      // Character matches
      qi++;
      consecutiveBonus++;
      score += 1 + consecutiveBonus;

      // Bonus for matching at word boundaries (after /, -, _, space, or start)
      if (ti === 0 || "/- _".includes(target[ti - 1])) {
        score += 5;
      }

      // Track highlight range
      if (rangeStart === -1) {
        rangeStart = ti;
      }
    } else {
      // Break in match
      consecutiveBonus = 0;
      if (rangeStart !== -1) {
        ranges.push([rangeStart, ti]);
        rangeStart = -1;
      }
    }
  }

  // Close final range
  if (rangeStart !== -1) {
    ranges.push([rangeStart, ranges.length > 0 ? rangeStart + (qi - (ranges.reduce((s, r) => s + r[1] - r[0], 0))) : qi + rangeStart]);
    // Simpler: just track where we stopped
  }

  // Did we match all query characters?
  if (qi < queryLower.length) return null;

  // Rebuild ranges more accurately with a second pass
  const accurateRanges = buildRanges(queryLower, targetLower);

  // Bonus for shorter targets (prefer more specific matches)
  score += Math.max(0, 20 - target.length);

  return { score, ranges: accurateRanges };
}

/** Build accurate highlight ranges by re-tracing the match. */
function buildRanges(query: string, target: string): [number, number][] {
  const ranges: [number, number][] = [];
  let qi = 0;
  let rangeStart = -1;

  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      if (rangeStart === -1) rangeStart = ti;
      qi++;
    } else {
      if (rangeStart !== -1) {
        ranges.push([rangeStart, ti]);
        rangeStart = -1;
      }
    }
  }

  if (rangeStart !== -1) {
    ranges.push([rangeStart, rangeStart + (qi - ranges.reduce((s, r) => s + r[1] - r[0], 0))]);
  }

  return ranges;
}
