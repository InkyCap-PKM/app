// Ordering maths for creation rules: which rules become toolbar buttons, and
// what the rule list looks like after one of those buttons is moved. Kept
// out of the store so it stays free of IPC and easy to test.

import type { CreationRule } from "./types";

/** Whether a rule renders as a button on the vertical toolbar. A disabled
 *  rule keeps its "show button in toolbar" setting but doesn't appear. */
export function isToolbarRule(rule: CreationRule): boolean {
  return rule.show_in_toolbar && !rule.disabled;
}

/** The rules that render as toolbar buttons, in the order they appear. */
export function toolbarOrder(rules: CreationRule[]): CreationRule[] {
  return rules.filter(isToolbarRule);
}

/** The id of the rule one place before (`delta` of -1) or after (`delta` of
 *  +1) `ruleId` on the toolbar, or null when there is none. Rules that
 *  aren't toolbar buttons are skipped, so "one place" always means one
 *  visible slot on the toolbar rather than one row of the settings list. */
export function toolbarNeighbourId(
  rules: CreationRule[],
  ruleId: string,
  delta: -1 | 1,
): string | null {
  const visible = toolbarOrder(rules);
  const pos = visible.findIndex((r) => r.id === ruleId);
  if (pos < 0) return null;
  return visible[pos + delta]?.id ?? null;
}

/** A copy of `rules` with the two named rules trading places. Every other
 *  rule stays put, so swapping two toolbar buttons leaves any non-toolbar
 *  rules sitting between them exactly where they were. An id that matches
 *  no rule leaves the list unchanged. */
export function swapRules(
  rules: CreationRule[],
  aId: string,
  bId: string,
): CreationRule[] {
  const out = [...rules];
  const a = out.findIndex((r) => r.id === aId);
  const b = out.findIndex((r) => r.id === bId);
  if (a < 0 || b < 0) return out;
  [out[a], out[b]] = [out[b], out[a]];
  return out;
}
