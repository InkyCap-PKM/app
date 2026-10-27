// Completions for a half-typed `tag:`, `path:`, `collection:` or `property:` filter in the search
// box. Plain string work, separate from the panel so the offsets can be tested.

/** What a completion offers: folders, tag names, collection names, property
 *  keys, or property values. */
export type CompletionKind = "path" | "tag" | "collection" | "property-key" | "property-value";

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
 * The filter value the caret is in, or null. The prefix must start a token, so
 * "tag:" inside a word doesn't count; a leading `-` (or a preceding `NOT`/`(`)
 * is allowed, since that is how filters are negated and grouped.
 */
const FILTER_AT_CARET =
  /(?:^|[\s(])-?(path|tag|collection|property):((?:[^\s()"]|"[^"]*"?)*)$/i;

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

  if (filter === "path" || filter === "tag" || filter === "collection") {
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
 * Whether a value can be written into a filter. The query language can't escape
 * a double quote, so a value containing one can't be searched for, and offering
 * it would search for something else.
 */
export function canComplete(value: string): boolean {
  return !value.includes('"');
}

/**
 * Replace the filter value with `value`, quoted if it contains anything that
 * would end the token. `suffix` goes after the quotes (a property key gets its
 * `=` so the value can be typed next). Returns the new query and the caret
 * position. `value` must pass `canComplete`.
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
 * Where the token starting at `start` ends: at whitespace or a grouping
 * parenthesis, except within quotes (`property:author="Athena Otlet"` is one
 * value).
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
