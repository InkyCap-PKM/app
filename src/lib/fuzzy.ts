// Match scoring for the app's pickers — quick open, the scaffold picker, the
// reference and citation lists, the command palette.

/**
 * How the query matched, wherever it landed. A better kind always outranks a
 * worse one, so matches are ordered by kind first and score second: "PDA" means
 * "PDA notes" before "Update Release Page and Downloads", however many word
 * starts the scattered letters hit.
 */
export type MatchKind =
  /** The target is the query. */
  | "exact"
  /** The query appears in the target as one unbroken run. */
  | "substring"
  /** The query's letters appear in order but with gaps between them. */
  | "scattered";

const KIND_RANK: Record<MatchKind, number> = {
  exact: 2,
  substring: 1,
  scattered: 0,
};

export interface FuzzyMatch {
  /** Higher is better, but only ever compared within one {@link MatchKind}. */
  score: number;
  /** Character index ranges that matched (for highlighting). */
  ranges: [number, number][];
  kind: MatchKind;
}

/**
 * Order two matches, best first. Every picker sorts with this, so they all rank
 * alike; callers add their own tiebreak (recency, name).
 */
export function compareMatches(a: FuzzyMatch, b: FuzzyMatch): number {
  return compareMatchKinds(a, b) || b.score - a.score;
}

/**
 * Order two matches by {@link MatchKind} only, best first, for pickers that
 * rank on something of their own between kind and score (such as which field
 * matched).
 */
export function compareMatchKinds(a: FuzzyMatch, b: FuzzyMatch): number {
  return KIND_RANK[b.kind] - KIND_RANK[a.kind];
}

/**
 * Substring match, as used by the plain text filters (agenda, sidebar,
 * references…). Null unless `query` appears in `target` as one case-insensitive
 * run; otherwise a score (higher is better) and the matched range. Unlike
 * {@link fuzzyMatch}, letters aren't matched apart: "exp" matches "Export" but
 * not "edit panel".
 */
export function substringMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const kind: MatchKind = t.trim() === q.trim() ? "exact" : "substring";

  if (query.length === 0) return { score: 0, ranges: [], kind };

  const idx = t.indexOf(q);
  if (idx === -1) return null;

  let score = 100 - idx; // an earlier match ranks higher
  if (idx === 0) {
    score += 30; // prefix match
  } else if ("/-_ :".includes(target[idx - 1])) {
    score += 15; // match at a word boundary
  }
  score += Math.max(0, 20 - target.length); // prefer shorter / more specific targets

  return { score, ranges: [[idx, idx + q.length]], kind };
}

/**
 * Score how well `query` matches `target`, preferring an unbroken run and
 * otherwise the query's letters in order with gaps, so "inkbuild" finds
 * "InkyCap - Build Binaries". Case-insensitive. Sort with {@link
 * compareMatches}, not `score` alone: a scattered match can collect enough
 * word-start points across a long name to beat a contiguous one.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, ranges: [], kind: "substring" };

  const contiguous = substringMatch(query, target);
  if (contiguous) return contiguous;

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  let qi = 0; // query index
  let score = 0;
  let run = 0; // length of the current unbroken stretch

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) {
      run = 0;
      continue;
    }
    qi++;
    run++;
    score += 1 + run; // longer stretches are worth more per character
    // Bonus for matching at word boundaries (after /, -, _, space, or start)
    if (ti === 0 || "/- _".includes(target[ti - 1])) {
      score += 5;
    }
  }

  // Did we match all query characters?
  if (qi < q.length) return null;

  // Bonus for shorter targets (prefer more specific matches)
  score += Math.max(0, 20 - target.length);

  return { score, ranges: buildRanges(q, t), kind: "scattered" };
}

/** Build highlight ranges by re-tracing the match. */
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
