// Working out what a half-typed `tag:` or `property:` filter in the search box
// could be completed with. Pure string work, kept out of the panel so the
// offsets are testable on their own.

/** What a completion offers: folders, tag names, property keys, or values. */
export type CompletionKind = "path" | "tag" | "property-key" | "property-value";

export interface SearchCompletionContext {
  kind: CompletionKind;
  /** The property key whose values are wanted. Empty for the other kinds. */
  key: string;
  /** What the user has typed so far, lowercased and unquoted, for filtering. */
  typed: string;
  /** The query range an accepted completion replaces. */
  from: number;
  to: number;
}

/**
 * The filter value the caret sits in, or null when it is somewhere else.
 *
 * The prefix has to start at a token boundary so a stray "tag:" inside a word
 * doesn't trigger, and a leading `-` (or a preceding `NOT`/`(`) is allowed
 * because those are how the query language negates and groups a filter.
 */
const FILTER_AT_CARET =
  /(?:^|[\s(])-?(path|tag|property):((?:[^\s()"]|"[^"]*"?)*)$/i;

export function completionContext(
  query: string,
  caret: number,
): SearchCompletionContext | null {
  const pos = Math.max(0, Math.min(caret, query.length));
  const match = FILTER_AT_CARET.exec(query.slice(0, pos));
  if (!match) return null;

  const filter = match[1].toLowerCase();
  const valueStart = pos - match[2].length;
  const valueEnd = tokenEnd(query, valueStart);
  const raw = query.slice(valueStart, valueEnd);

  if (filter === "path" || filter === "tag") {
    return { kind: filter, key: "", typed: normalize(raw), from: valueStart, to: valueEnd };
  }

  // `property:key` names a key; `property:key=value` narrows to a value, so
  // which list to offer depends on whether the `=` has been typed yet.
  const equals = raw.indexOf("=");
  if (equals === -1) {
    return {
      kind: "property-key",
      key: "",
      typed: normalize(raw),
      from: valueStart,
      to: valueEnd,
    };
  }
  return {
    kind: "property-value",
    key: normalize(raw.slice(0, equals)),
    typed: normalize(raw.slice(equals + 1)),
    from: valueStart + equals + 1,
    to: valueEnd,
  };
}

/**
 * Whether a value can be written into a filter at all. The query language has
 * no way to escape a double quote — a quote always opens or closes a run — so
 * a tag or property value containing one cannot be searched for by name, and
 * offering it would only produce a filter for some other string.
 */
export function canComplete(value: string): boolean {
  return !value.includes('"');
}

/**
 * Replace the filter value with `value`, quoting it when it contains anything
 * that would otherwise end the token. `suffix` is appended outside the quotes —
 * a chosen property key carries its `=` so the value can be typed next.
 * Returns the new query text and where the caret belongs in it. `value` must
 * pass `canComplete`.
 */
export function applyCompletion(
  query: string,
  context: SearchCompletionContext,
  value: string,
  suffix = "",
): { text: string; caret: number } {
  const quoted = /[\s()]/.test(value) ? `"${value}"` : value;
  const inserted = quoted + suffix;
  return {
    text: query.slice(0, context.from) + inserted + query.slice(context.to),
    caret: context.from + inserted.length,
  };
}

/**
 * Where the token starting at `start` ends. Whitespace and the grouping
 * parentheses end a token, except inside quotes — `property:author="Jane Doe"`
 * is one value, spaces and all.
 */
function tokenEnd(query: string, start: number): number {
  let pos = start;
  let inQuote = false;
  while (pos < query.length) {
    const ch = query[pos];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (!inQuote && /[\s()]/.test(ch)) {
      break;
    }
    pos++;
  }
  return pos;
}

/** Lowercase and strip the quotes a value may be wrapped in. */
function normalize(value: string): string {
  let out = value;
  if (out.startsWith('"')) out = out.slice(1);
  if (out.endsWith('"')) out = out.slice(0, -1);
  return out.toLowerCase();
}
