// Parser for Typst tables in the form the visual widget can render. Returns
// TableData, or null for tables using features it can't (spans, spreads,
// computed cells, …).

export interface TableCell {
  content: string;
  /** Offset relative to the start of the #table(...) call text */
  relFrom: number;
  /** Offset relative to the start of the #table(...) call text */
  relTo: number;
}

export interface TableData {
  columns: string[];
  align: string[] | null;
  /**
   * Explicit row heights from Typst's `rows:` (one per row, header included):
   * `auto` fits the content, a length (e.g. `30pt`) is set by dragging. `null`
   * without a `rows:` argument.
   */
  rowSizes: string[] | null;
  /**
   * Named arguments the widget doesn't model (`stroke`, `inset`, `fill`,
   * `gutter`, a non-array `align` / `rows`, …), kept as written, in order, and
   * written back unchanged, so styled tables can still be edited without loss.
   * Empty when there are none.
   */
  extraArgs: { key: string; value: string }[];
  header: TableCell[] | null;
  rows: TableCell[][];
  /** Full source text of the #table(...) call */
  sourceText: string;
}

/**
 * Parse a `#table(...)` call into TableData, or null if the widget can't
 * represent it. It needs:
 *
 * - `columns:` as an array `(...)` of fr / auto / length values (or an
 *   integer);
 * - an optional array `align:`;
 * - an optional `table.header(...)` as the first positional argument;
 * - `[...]` content blocks for every other positional argument;
 * - no `table.cell(...)`, `table.hline(...)`, spreads or computed content.
 *
 * Other named arguments are kept in `extraArgs`.
 */
export function parseCanonicalTable(text: string): TableData | null {
  // Must start with #table( or table(
  const hashOffset = text.startsWith("#") ? 1 : 0;
  const funcStart = text.indexOf("table(", hashOffset);
  if (funcStart !== hashOffset) return null;

  const outerParenIdx = text.indexOf("(", hashOffset);
  if (outerParenIdx < 0) return null;

  const closeIdx = findMatchingParen(text, outerParenIdx);
  if (closeIdx < 0) return null;

  const inner = text.substring(outerParenIdx + 1, closeIdx);

  // Parse all top-level arguments (named and positional)
  const args = parseTopLevelArgs(inner, outerParenIdx + 1);
  if (!args) return null;

  let columns: string[] | null = null;
  let align: string[] | null = null;
  let rowSizes: string[] | null = null;
  const extraArgs: { key: string; value: string }[] = [];
  let header: TableCell[] | null = null;
  const rows: TableCell[][] = [];
  let currentRow: TableCell[] = [];

  for (const arg of args) {
    if (arg.type === "named") {
      const key = arg.key as string;
      if (key === "columns") {
        columns = parseColumnsArg(arg.value);
        // `columns` defines the grid; if it isn't an array/integer we can't
        // build cells, so this one genuinely blocks the widget.
        if (!columns) return null;
      } else if (key === "align") {
        // Model an explicit `(…)` array per-column; preserve anything else
        // (a bare `center`, a function, …) verbatim so it still round-trips.
        align = parseArrayLiteral(arg.value);
        if (!align) extraArgs.push({ key, value: arg.value });
      } else if (key === "rows") {
        // An array of row heights gets a drag handle per row; a single length
        // or integer repeats in Typst and can't map to handles, so it is kept
        // as written.
        rowSizes = parseArrayLiteral(arg.value);
        if (!rowSizes) extraArgs.push({ key, value: arg.value });
      } else {
        // Any other named arg (stroke, inset, fill, gutter, …) is opaque
        // styling we keep verbatim and re-emit on serialize.
        extraArgs.push({ key, value: arg.value });
      }
    } else {
      // Positional arg
      if (arg.value.startsWith("table.header(")) {
        if (header !== null) return null; // multiple headers
        if (currentRow.length > 0) return null; // header must come first
        header = parseTableHeader(arg.value, arg.relFrom);
        if (!header) return null;
      } else if (arg.value.startsWith("[")) {
        const cell = parseCellBracket(arg.value, arg.relFrom);
        if (!cell) return null;
        currentRow.push(cell);
      } else {
        // Non-bracket positional arg — computed content, non-canonical
        return null;
      }
    }
  }

  if (!columns) return null;

  // Flush any trailing partial row
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  // Validate: reorganize cells into rows based on column count
  const colCount = columns.length;
  const allCells = rows.flat();
  if (allCells.length % colCount !== 0 && allCells.length > 0) {
    // Cells don't evenly divide into rows — might be OK for partial last row
    // but let's be strict for now
    return null;
  }

  // Re-chunk cells into proper rows
  const properRows: TableCell[][] = [];
  for (let i = 0; i < allCells.length; i += colCount) {
    properRows.push(allCells.slice(i, i + colCount));
  }

  // Also validate header cell count
  if (header && header.length !== colCount) return null;

  return {
    columns,
    align,
    rowSizes,
    extraArgs,
    header,
    rows: properRows,
    sourceText: text,
  };
}

/** Serialize TableData back to Typst source. */
export function serializeTable(data: TableData): string {
  const lines: string[] = [];
  lines.push("#table(");
  lines.push(`  columns: (${data.columns.join(", ")}),`);

  // Write the kept styling arguments right after `columns`, where they usually
  // sit.
  for (const { key, value } of data.extraArgs ?? []) {
    lines.push(`  ${key}: ${value},`);
  }

  // Only emit `rows:` when at least one row carries an explicit override —
  // an all-`auto` array is redundant noise in the source.
  if (data.rowSizes && data.rowSizes.some((r) => r !== "auto")) {
    lines.push(`  rows: (${data.rowSizes.join(", ")}),`);
  }

  if (data.align) {
    lines.push(`  align: (${data.align.join(", ")}),`);
  }

  if (data.header) {
    const headerCells = data.header.map((c) => `[${c.content}]`).join(", ");
    lines.push(`  table.header(${headerCells}),`);
  }

  for (const row of data.rows) {
    const rowCells = row.map((c) => `[${c.content}]`).join(", ");
    lines.push(`  ${rowCells},`);
  }

  lines.push(")");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ParsedArg {
  type: "named" | "positional";
  key?: string;
  value: string;
  /** Offset relative to the start of the full #table(...) text */
  relFrom: number;
}

function parseTopLevelArgs(inner: string, baseOffset: number): ParsedArg[] | null {
  const args: ParsedArg[] = [];
  let i = 0;

  while (i < inner.length) {
    // Skip whitespace and commas
    while (i < inner.length && (isWhitespace(inner[i]) || inner[i] === ",")) {
      i++;
    }
    if (i >= inner.length) break;

    // Try to parse as named arg: `identifier:` or `identifier-with-dashes:`
    const namedMatch = tryParseNamedArg(inner, i);
    if (namedMatch) {
      const valueStart = namedMatch.valueStart;
      const valueEnd = findArgEnd(inner, valueStart);
      const value = inner.substring(valueStart, valueEnd).trim();
      args.push({
        type: "named",
        key: namedMatch.key,
        value,
        relFrom: baseOffset + i,
      });
      i = valueEnd;
    } else {
      // Positional arg — find its end
      const argStart = i;
      const argEnd = findArgEnd(inner, i);
      const value = inner.substring(argStart, argEnd).trim();
      if (value.length > 0) {
        args.push({
          type: "positional",
          value,
          relFrom: baseOffset + argStart,
        });
      }
      i = argEnd;
    }
  }

  return args;
}

function tryParseNamedArg(
  text: string,
  start: number,
): { key: string; valueStart: number } | null {
  let i = start;
  // Identifier chars: alphanumeric, underscore, hyphen
  while (
    i < text.length &&
    (isAlphanumeric(text[i]) || text[i] === "_" || text[i] === "-")
  ) {
    i++;
  }
  if (i === start) return null;

  const key = text.substring(start, i);

  // Skip whitespace before colon
  let j = i;
  while (j < text.length && isWhitespace(text[j])) j++;

  if (j >= text.length || text[j] !== ":") return null;

  // Make sure this isn't inside a bracket or something — the colon must
  // be followed by a space or value, not another colon (::)
  if (j + 1 < text.length && text[j + 1] === ":") return null;

  // Skip whitespace after colon
  let valueStart = j + 1;
  while (valueStart < text.length && isWhitespace(text[valueStart])) {
    valueStart++;
  }

  return { key, valueStart };
}

/**
 * End of a top-level argument: the next `,` (or a stray `)` / `]`) not inside a
 * group, markup block, string or inline raw. The argument list is code, so
 * strings count; inside a `[…]` cell the markup rules apply (see
 * `skipBracket`).
 */
function findArgEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "," || ch === ")" || ch === "]") return i;
    if (ch === '"') {
      i = skipString(text, i);
      continue;
    }
    if (ch === "`") {
      i = skipInlineRaw(text, i);
      continue;
    }
    if (ch === "(") {
      i = skipParen(text, i);
      continue;
    }
    if (ch === "[") {
      i = skipBracket(text, i);
      continue;
    }
    i++;
  }
  return i;
}

/** Index of the `)` that closes the group opened at `openIdx`, or -1. */
function findMatchingParen(text: string, openIdx: number): number {
  const end = skipParen(text, openIdx);
  return text[end - 1] === ")" && end > openIdx + 1 ? end - 1 : -1;
}

/**
 * Skip a `(…)` group starting at `text[start]`. Returns the index after `)`, or
 * `text.length` if unclosed. Strings, nested groups and markup blocks are
 * skipped whole, so a `)` inside them doesn't close it.
 */
function skipParen(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = skipString(text, i);
      continue;
    }
    if (ch === "`") {
      i = skipInlineRaw(text, i);
      continue;
    }
    if (ch === "(") {
      i = skipParen(text, i);
      continue;
    }
    if (ch === "[") {
      i = skipBracket(text, i);
      continue;
    }
    if (ch === ")") return i + 1;
    i++;
  }
  return i;
}

/**
 * Skip a markup block starting at `text[start] === "["`. Returns the index
 * after `]`, or `text.length` if unclosed.
 *
 * In markup, quotes, parens and commas are text: `[She said "no (twice), then
 * left]` is one cell. Only a nested `[…]`, inline raw and a `#` expression
 * (whose arguments are code again, `[#wikilink("a, b")]`) change that. `\]`
 * doesn't close the block.
 */
function skipBracket(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      i = skipInlineRaw(text, i);
      continue;
    }
    if (ch === "[") {
      i = skipBracket(text, i);
      continue;
    }
    if (ch === "]") return i + 1;
    if (ch === "#") {
      i = skipHashExpr(text, i);
      continue;
    }
    i++;
  }
  return i;
}

/**
 * Skip a `#` expression in markup: the name (dots allowed, `#table.cell`) and
 * any `(…)` and `[…]` groups after it, e.g. `#link("https://x.y")[label]`. A
 * `#` without a name is text.
 */
function skipHashExpr(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && (isAlphanumeric(text[i]) || text[i] === "_" || text[i] === "-" || text[i] === ".")) {
    i++;
  }
  if (i === start + 1) return i;
  for (;;) {
    if (text[i] === "(") {
      i = skipParen(text, i);
    } else if (text[i] === "[") {
      i = skipBracket(text, i);
    } else {
      return i;
    }
  }
}

/**
 * If `text[start]` starts inline raw (backticks), the index after the matching
 * closing run; otherwise `start`. Brackets and quotes inside raw are literal.
 * Like the raw skip in the visual decorations.
 */
function skipInlineRaw(text: string, start: number): number {
  if (text[start] !== "`") return start;
  let n = 1;
  while (start + n < text.length && text[start + n] === "`") n++;
  const fence = "`".repeat(n);
  const close = text.indexOf(fence, start + n);
  return close >= 0 ? close + n : text.length;
}

function skipString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i++;
  }
  return i;
}

/** Parse `columns:` as an array `(1fr, 2fr, auto)` or an integer `2`. */
function parseColumnsArg(value: string): string[] | null {
  const trimmed = value.trim();

  // Integer shorthand: `columns: 3` → treat as 3 auto columns.
  const intMatch = /^\d+$/.exec(trimmed);
  if (intMatch) {
    const n = parseInt(trimmed, 10);
    if (n > 0 && n <= 50) return Array(n).fill("auto");
    return null;
  }

  return parseArrayLiteral(trimmed);
}

/**
 * Elements of an array literal like `(1fr, 2fr, auto)`, or null if it isn't
 * one.
 */
function parseArrayLiteral(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return null;

  const inner = trimmed.substring(1, trimmed.length - 1);
  const items = inner.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (items.length === 0) return null;

  return items;
}

/** Parse `table.header([Cell1], [Cell2], ...)` into cells. */
function parseTableHeader(text: string, baseRelFrom: number): TableCell[] | null {
  const parenIdx = text.indexOf("(");
  if (parenIdx < 0) return null;

  const closeIdx = findMatchingParen(text, parenIdx);
  if (closeIdx < 0) return null;

  const inner = text.substring(parenIdx + 1, closeIdx);
  const innerOffset = baseRelFrom + parenIdx + 1;

  return parseCellList(inner, innerOffset);
}

/** Parse a comma-separated list of `[...]` blocks. */
function parseCellList(text: string, baseOffset: number): TableCell[] | null {
  const cells: TableCell[] = [];
  let i = 0;

  while (i < text.length) {
    while (i < text.length && (isWhitespace(text[i]) || text[i] === ",")) {
      i++;
    }
    if (i >= text.length) break;

    // Accept both `[content]` and `table.cell[content]`
    const tableCellPrefix = "table.cell";
    let cellStart = i;
    if (text.startsWith(tableCellPrefix, i)) {
      cellStart = i + tableCellPrefix.length;
    }

    if (text[cellStart] !== "[") return null;

    const cellEnd = skipBracket(text, cellStart);
    const content = text.substring(cellStart + 1, cellEnd - 1);
    cells.push({
      content,
      relFrom: baseOffset + i,
      relTo: baseOffset + cellEnd,
    });
    i = cellEnd;
  }

  return cells;
}

/** Parse one `[content]` block into a TableCell. */
function parseCellBracket(value: string, baseRelFrom: number): TableCell | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;

  const content = trimmed.substring(1, trimmed.length - 1);
  // Find the actual bracket positions in the untrimmed value
  const openIdx = value.indexOf("[");
  const closeIdx = value.lastIndexOf("]");

  return {
    content,
    relFrom: baseRelFrom + openIdx,
    relTo: baseRelFrom + closeIdx + 1,
  };
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isAlphanumeric(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) // a-z
  );
}

/**
 * Clipboard data as a grid of strings: an HTML table if present, otherwise
 * tab-separated text.
 */
export function parseClipboardAsGrid(e: ClipboardEvent): string[][] | null {
  const html = e.clipboardData?.getData("text/html");
  if (html) {
    const grid = parseHtmlTableToGrid(html);
    if (grid) return grid;
  }

  const text = e.clipboardData?.getData("text/plain");
  if (text) return parseTsvToGrid(text);

  return null;
}

function parseHtmlTableToGrid(html: string): string[][] | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return null;

  const grid: string[][] = [];
  for (const row of table.querySelectorAll("tr")) {
    const rowData: string[] = [];
    for (const cell of row.querySelectorAll("td, th")) {
      rowData.push((cell.textContent ?? "").trim());
    }
    if (rowData.length > 0) grid.push(rowData);
  }

  return grid.length > 0 ? grid : null;
}

/** The whole table, header first, as tab-separated rows of cell source. */
export function tableToTsv(data: TableData): string {
  const rows = data.header ? [data.header, ...data.rows] : data.rows;
  return rows.map((row) => row.map((cell) => cell.content).join("\t")).join("\n");
}

/** Clipboard text as a grid: tab-separated rows when it has tabs, otherwise
 *  the whole text as a single cell. Empty text yields null. */
export function textToGrid(text: string): string[][] | null {
  if (text.length === 0) return null;
  return parseTsvToGrid(text) ?? [[text]];
}

export function parseTsvToGrid(text: string): string[][] | null {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return null;

  // Plain text is a table only if it has tabs and at least one row has two or
  // more columns, so prose (even with runs of spaces, like copied verse) is
  // never turned into a table.
  if (!lines.some(l => l.includes("\t"))) return null;
  const grid = lines.map(l => l.split("\t"));
  if (!grid.some(r => r.length >= 2)) return null;
  return grid;
}
