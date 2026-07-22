// Table re-rendering for Discord: session text (assistant summaries, milestones) arrives
// sized for a TERMINAL — box-drawing tables 80+ columns wide, or markdown pipe tables that
// Discord does not render at all. Outside a code fence Discord's proportional font shreds
// box alignment entirely; inside one, a phone shows ~40 monospace columns and wraps the
// BORDERS instead of the text, which reads as garbage.
//
// This module finds both table forms and re-renders them as a compact box that fits a
// target width, wrapping text INSIDE cells (multi-line rows) so the frame always survives,
// then wraps the result in a code fence for monospaced alignment. Everything else in the
// text passes through untouched. Pure string transforms — no discord.js — so it unit-tests
// without a bot.
//
// Honesty rules: content is never dropped. A run of box-drawing lines that fails to parse
// as a consistent table is still fenced verbatim (monospace beats soup); text already
// inside a code fence is left exactly as authored.

/** Target rendered width. Chosen for the narrowest real surface — a phone-width embed
 *  description shows roughly this many monospace columns before Discord wraps the line. */
export const DEFAULT_TABLE_WIDTH = 40;

/** Columns never shrink below this: a narrower column wraps every word and reads worse
 *  than letting the whole table run slightly past the target width. */
const MIN_COL_WIDTH = 6;

/** A parsed table: rows of cell text, plus which row gaps had a horizontal separator in
 *  the source (markdown tables get one after the header; box tables keep their own). */
interface ParsedTable {
  rows: string[][];
  separatorAfterRow: boolean[];
}

// The LIGHT box set (plus rounded corners) that terminal table renderers actually emit.
// Deliberately excludes the heavy/double variants (┏━╔═): they are far likelier decorative
// art than data, and a wrong parse would mangle them — unmatched lines pass through intact.
const BOX_CHARS = /[─│┌┬┐├┼┤└┴┘╭╮╰╯]/;
/** A line that belongs to a box-drawing table: first and last visible chars are box glyphs.
 *  Requiring BOTH ends keeps prose that merely mentions a box char from being captured. */
function isBoxLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 2) return false;
  return BOX_CHARS.test(t[0] as string) && BOX_CHARS.test(t[t.length - 1] as string);
}

/** A horizontal border/separator row (top, bottom, or between-rows) as opposed to a data row. */
function isBoxSeparator(line: string): boolean {
  const t = line.trim();
  return /^[┌├└╭╰]/.test(t) || /^─/.test(t);
}

/** The markdown header/body delimiter: pipes, dashes, colons, and spaces only, at least one
 *  dash — `|---|:--:|` and friends. */
function isMarkdownSeparator(line: string): boolean {
  const t = line.trim();
  return /^\|?[\s:|-]+\|?$/.test(t) && t.includes('-') && t.includes('|');
}

/** A plausible markdown table row: contains a pipe with content around it. */
function isMarkdownRow(line: string): boolean {
  return line.includes('|') && line.trim().length > 1;
}

/** Split one markdown row into trimmed cells, dropping the empty edges a leading/trailing
 *  pipe produces. */
function markdownCells(line: string): string[] {
  const cells = line.split('|').map((c) => c.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** Split one box-drawing data row (│ a │ b │) into trimmed cells. */
function boxCells(line: string): string[] {
  const t = line.trim();
  const inner = t.replace(/^│/, '').replace(/│$/, '');
  return inner.split('│').map((c) => c.trim());
}

/** Parse a run of box-drawing lines into rows + separator placement, or undefined when the
 *  run is not a consistent table (mismatched column counts, no data rows at all). */
function parseBoxBlock(lines: string[]): ParsedTable | undefined {
  const rows: string[][] = [];
  const separatorAfterRow: boolean[] = [];
  for (const line of lines) {
    if (isBoxSeparator(line)) {
      if (rows.length > 0) separatorAfterRow[rows.length - 1] = true;
      continue;
    }
    rows.push(boxCells(line));
    separatorAfterRow.push(false);
  }
  if (rows.length === 0) return undefined;
  const cols = rows[0]?.length ?? 0;
  if (cols === 0 || rows.some((r) => r.length !== cols)) return undefined;
  // The bottom border's "separator after the last row" flag is meaningless — the renderer
  // always closes the box — so it is deliberately ignored via slice length.
  return { rows, separatorAfterRow: separatorAfterRow.slice(0, rows.length) };
}

/** Parse a markdown pipe table (header, separator, body) into rows. The separator row is
 *  dropped; its position is remembered as "separator after the header". */
function parseMarkdownBlock(lines: string[]): ParsedTable | undefined {
  const rows: string[][] = [];
  const separatorAfterRow: boolean[] = [];
  for (const line of lines) {
    if (isMarkdownSeparator(line)) {
      if (rows.length > 0) separatorAfterRow[rows.length - 1] = true;
      continue;
    }
    rows.push(markdownCells(line));
    separatorAfterRow.push(false);
  }
  if (rows.length < 2) return undefined;
  const cols = rows[0]?.length ?? 0;
  if (cols < 2 || rows.some((r) => r.length !== cols)) return undefined;
  return { rows, separatorAfterRow: separatorAfterRow.slice(0, rows.length) };
}

/** Greedy word-wrap of one cell to `width`, hard-splitting tokens longer than the width
 *  (URLs, ids) so no content is ever lost. Always returns at least one line. */
function wrapCell(text: string, width: number): string[] {
  const out: string[] = [];
  let current = '';
  const push = () => {
    out.push(current);
    current = '';
  };
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    let w = word;
    // Hard-split an over-long token into width-sized chunks; the last chunk flows normally.
    while (w.length > width) {
      if (current.length > 0) push();
      out.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (current.length === 0) current = w;
    else if (current.length + 1 + w.length <= width) current += ` ${w}`;
    else {
      push();
      current = w;
    }
  }
  if (current.length > 0 || out.length === 0) push();
  return out;
}

/** Column widths for the target: natural (widest cell) when they fit; otherwise the widest
 *  column gives up characters first, one at a time, until the budget is met or every column
 *  sits at its floor (its natural width or MIN_COL_WIDTH, whichever is smaller — a column is
 *  never padded BEYOND its content, and never squeezed into unreadability). When even the
 *  floors overflow the budget, the floors win: a slightly-too-wide table beats mangled cells. */
function columnWidths(rows: string[][], maxWidth: number): number[] {
  const cols = rows[0]?.length ?? 0;
  const natural = Array.from({ length: cols }, (_, i) =>
    Math.max(1, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const budget = maxWidth - (3 * cols + 1); // '│ ' + ' │ ' joints + closing '│'
  const floors = natural.map((w) => Math.min(w, MIN_COL_WIDTH));
  const widths = [...natural];
  let sum = widths.reduce((a, b) => a + b, 0);
  while (sum > budget) {
    let widest = -1;
    for (let i = 0; i < cols; i++) {
      if (
        (widths[i] as number) > (floors[i] as number) &&
        (widest === -1 || (widths[i] as number) > (widths[widest] as number))
      ) {
        widest = i;
      }
    }
    if (widest === -1) break; // every column at its floor — accept the overflow
    widths[widest] = (widths[widest] as number) - 1;
    sum--;
  }
  return widths;
}

function border(widths: number[], left: string, joint: string, right: string): string {
  return left + widths.map((w) => '─'.repeat(w + 2)).join(joint) + right;
}

/** Render parsed rows back into an aligned box at the target width, wrapping cell text into
 *  multi-line rows where columns had to shrink. */
function renderTable(table: ParsedTable, maxWidth: number): string {
  const widths = columnWidths(table.rows, maxWidth);
  const lines: string[] = [border(widths, '┌', '┬', '┐')];
  table.rows.forEach((row, rowIndex) => {
    const wrapped = row.map((cell, i) => wrapCell(cell, widths[i] as number));
    const height = Math.max(...wrapped.map((c) => c.length));
    for (let k = 0; k < height; k++) {
      lines.push(
        '│' +
          wrapped.map((c, i) => ` ${(c[k] ?? '').padEnd(widths[i] as number)} `).join('│') +
          '│',
      );
    }
    const last = rowIndex === table.rows.length - 1;
    if (!last && table.separatorAfterRow[rowIndex]) {
      lines.push(border(widths, '├', '┼', '┤'));
    }
  });
  lines.push(border(widths, '└', '┴', '┘'));
  return lines.join('\n');
}

/** Fence a block of already-monospace-shaped lines verbatim — the fallback for box runs
 *  that would not parse as one consistent table. */
function fenceRaw(lines: string[]): string {
  return '```\n' + lines.join('\n') + '\n```';
}

/**
 * Re-render every table in `text` for Discord: box-drawing and markdown pipe tables become
 * compact fenced boxes at most ~`maxWidth` columns wide; all other lines (and anything the
 * author already fenced) pass through byte-identical. Returns the input unchanged when no
 * table is found, so callers can apply this unconditionally.
 */
export function formatTables(text: string, maxWidth = DEFAULT_TABLE_WIDTH): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }

    if (isBoxLine(line)) {
      const start = i;
      while (i < lines.length && isBoxLine(lines[i] as string)) i++;
      const block = lines.slice(start, i);
      // A lone box-glyph line is likelier a divider than a table — leave it be.
      if (block.length < 2) {
        out.push(...block);
        continue;
      }
      const parsed = parseBoxBlock(block);
      out.push(parsed ? '```\n' + renderTable(parsed, maxWidth) + '\n```' : fenceRaw(block));
      continue;
    }

    // Markdown table: only enter when the SECOND line is the header separator — a stray
    // pipe in prose must not trigger a rewrite.
    if (
      isMarkdownRow(line) &&
      i + 1 < lines.length &&
      isMarkdownSeparator(lines[i + 1] as string)
    ) {
      const start = i;
      while (
        i < lines.length &&
        (isMarkdownRow(lines[i] as string) || isMarkdownSeparator(lines[i] as string))
      ) {
        i++;
      }
      const block = lines.slice(start, i);
      const parsed = parseMarkdownBlock(block);
      if (parsed) {
        out.push('```\n' + renderTable(parsed, maxWidth) + '\n```');
        continue;
      }
      out.push(...block);
      continue;
    }

    out.push(line);
    i++;
  }
  return out.join('\n');
}
