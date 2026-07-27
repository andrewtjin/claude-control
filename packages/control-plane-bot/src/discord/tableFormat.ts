// Table re-rendering for Discord: session text (assistant summaries, milestones) arrives
// sized for a TERMINAL — box-drawing tables 80+ columns wide, or markdown pipe tables that
// Discord does not render at all. Outside a code fence Discord's proportional font shreds
// box alignment entirely; inside one, a phone shows ~40 monospace columns and wraps the
// BORDERS instead of the text, which reads as garbage.
//
// This module finds both table forms and re-renders them at a target width, then wraps the
// result in a code fence for monospaced alignment. Everything else in the text passes through
// untouched. Pure string transforms — no discord.js — so it unit-tests without a bot.
//
// TWO layouts, because a grid is only right for one shape of table. Short cells become a
// compact box, text wrapped INSIDE cells so the frame always survives. Cells holding whole
// SENTENCES cannot: a phone-width box gives each of them a fifth of the line, every cell wraps
// into a tall stack, and the borders end up outnumbering the words. Those tables render as
// records instead — one block per row, first cell as its heading — which is how prose wants to
// be read on a phone anyway.
//
// Honesty rules: content is never dropped. A run of box-drawing lines that fails to parse
// as a consistent table is still fenced as-is (monospace beats soup); text already inside a
// code fence is left exactly as authored.

/** Target rendered width. Chosen for the narrowest real surface — a phone-width embed
 *  description shows roughly this many monospace columns before Discord wraps the line. */
export const DEFAULT_TABLE_WIDTH = 40;

/** Columns never shrink below this: a narrower column wraps every word and reads worse
 *  than letting the whole table run slightly past the target width. */
const MIN_COL_WIDTH = 6;

/** Continuation indent for a record's non-heading fields — enough to read as "this belongs to
 *  the line above" without eating width the prose needs. */
const RECORD_INDENT = '  ';

/** A parsed table: rows of cell text, plus which row gaps get a horizontal separator in the
 *  render (markdown tables separate every row — the syntax has no way to say "no separator
 *  here" past the header delimiter, so leaving later gaps unmarked ran every body row after
 *  the first into the next; box tables keep whatever the source itself drew). */
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

/** Parse a markdown pipe table (header, separator, body) into rows. The delimiter row is
 *  dropped entirely — its only job was marking where the header ends, not how many separators
 *  the render gets. Markdown syntax puts every row on its own line with no way to opt a pair of
 *  them out of a separator, so every gap is a boundary; see `ParsedTable`. */
function parseMarkdownBlock(lines: string[]): ParsedTable | undefined {
  const rows: string[][] = [];
  for (const line of lines) {
    if (isMarkdownSeparator(line)) continue;
    rows.push(markdownCells(line));
  }
  if (rows.length < 2) return undefined;
  const cols = rows[0]?.length ?? 0;
  if (cols < 2 || rows.some((r) => r.length !== cols)) return undefined;
  return { rows, separatorAfterRow: rows.map((_, i) => i < rows.length - 1) };
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
    // Measured and cut by CODE POINT, not by UTF-16 unit: `slice` cuts units, so a cut landing
    // inside a surrogate pair turns one astral character (emoji, rarer CJK) into two orphaned
    // halves that render as U+FFFD. That is content destroyed, which this module does not do.
    let chars = [...word];
    // Hard-split an over-long token into width-sized chunks; the last chunk flows normally.
    while (chars.length > width) {
      if (current.length > 0) push();
      out.push(chars.slice(0, width).join(''));
      chars = chars.slice(width);
    }
    const w = chars.join('');
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

/** Everything in a rendered grid line that is not cell text: a space either side of every cell,
 *  a '│' between adjacent cells, and the two outer '│'. Shared by the width budget and the
 *  fits-the-target check so the two can never disagree about what a grid costs. */
function scaffoldWidth(cols: number): number {
  return 3 * cols + 1;
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
  const budget = maxWidth - scaffoldWidth(cols);
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

/** Render parsed rows into an aligned box at the given column widths, wrapping cell text into
 *  multi-line rows where columns had to shrink. */
function renderGrid(table: ParsedTable, widths: number[]): string {
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

/**
 * Whether the grid layout still works for this table. Two gates, because a grid fails in two
 * directions.
 *
 * WIDTH: `columnWidths` lets the per-column floors win when even they overflow the budget, so a
 * table of many short cells renders a box far wider than the target — twenty one-word columns
 * still run past a hundred. That is precisely the phone-shredding grid this module exists to
 * replace, and the record layout handles it, so a grid that cannot be made to fit is not kept.
 *
 * HEIGHT: the width budget bottoms out at MIN_COL_WIDTH per column, so a target of `maxWidth`
 * holds at most this many columns — 6 at the default width. Allow a cell the same number of
 * LINES: one that wraps TALLER than the table could ever be WIDE has stopped being a label and
 * become a paragraph, and a paragraph reads better as a record than as a column of five-word
 * fragments.
 */
function fitsGrid(rows: string[][], widths: number[], maxWidth: number): boolean {
  const rendered = widths.reduce((a, b) => a + b, 0) + scaffoldWidth(widths.length);
  if (rendered > maxWidth) return false;
  const maxLines = Math.floor(maxWidth / MIN_COL_WIDTH);
  return rows.every((row) =>
    row.every((cell, i) => wrapCell(cell, widths[i] as number).length <= maxLines),
  );
}

/** One field of a record: `lead` prefixes its first line (a `LABEL: `, or the indent that marks a
 *  continuation field) and every wrapped line after it is padded to the same offset, so the field
 *  reads as one block however far it wraps. An empty cell contributes nothing — no content to lose.
 *  A pathologically long label still leaves MIN_COL_WIDTH of text: the same "a slightly-too-wide
 *  line beats a mangled one" trade the grid's column floors make. */
function renderField(cell: string, lead: string, maxWidth: number): string[] {
  if (cell.length === 0) return [];
  const pad = ' '.repeat(lead.length);
  return wrapCell(cell, Math.max(MIN_COL_WIDTH, maxWidth - lead.length)).map(
    (line, i) => (i === 0 ? lead : pad) + line,
  );
}

/**
 * Render parsed rows as one RECORD per row: the first cell is the record's heading, the rest sit
 * under it, and each field gets the FULL target width to wrap into — where the grid would have
 * given it a fifth of that.
 *
 * Past two fields, position alone no longer says which cell is which, so each field is prefixed
 * with its column's header. That header is taken only from a row the SOURCE marked as one, so a
 * headerless table never has its first data row eaten as labels. With two fields the shape is
 * unambiguous, so no prefixes — and the header row simply renders as the first record, since
 * dropping it would lose content.
 */
function renderRecords(table: ParsedTable, maxWidth: number): string {
  const header = table.separatorAfterRow[0] === true ? table.rows[0] : undefined;
  const labels =
    header !== undefined && header.length > 2
      ? // A blank corner cell (`| | Tradeoff | Recommendation |`) is a common header idiom: it
        // names nothing, so it contributes padding and not a bare `:` in front of every record.
        header.map((h) => (h.length > 0 ? `${h.toUpperCase()}:` : ''))
      : undefined;
  // Every label is padded to the widest so the values start in one column and the record scans
  // vertically, the way the grid's cells used to.
  const labelWidth = Math.max(0, ...(labels ?? []).map((l) => l.length)) + 1;
  const rows = labels ? table.rows.slice(1) : table.rows;
  return (
    rows
      .map((row) =>
        row.flatMap((cell, i) => {
          const lead = labels
            ? (labels[i] ?? '').padEnd(labelWidth)
            : i === 0
              ? '' // the record's heading owns the full width
              : RECORD_INDENT;
          return renderField(cell, lead, maxWidth);
        }),
      )
      // A blank line is the record boundary, so an all-empty row must not emit an empty block.
      .filter((block) => block.length > 0)
      .map((block) => block.join('\n'))
      .join('\n\n')
  );
}

/**
 * Neutralize every backtick RUN long enough to close a code fence, so text placed inside one can
 * never terminate it: a zero-width space goes between the backticks of any run of three or more.
 * Every character stays; only the adjacency that Discord reads as a fence is gone.
 *
 * Runs, not each literal ```, because four backticks is the ordinary way to fence a block that
 * itself contains a fence — and defusing only the first three leaves the fourth sitting against
 * the two that were emitted, rebuilding a ``` a character further along. Separating every
 * backtick in the run leaves no two adjacent, so nothing can reassemble at any length.
 *
 * The cost is that a three-plus backtick span shows its backticks instead of becoming a chip —
 * cheap, since everything inside a fence is already monospace.
 */
export function defuseFences(body: string): string {
  const zeroWidthSpace = String.fromCharCode(0x200b);
  return body.replace(/`{3,}/g, (run) => [...run].join(zeroWidthSpace));
}

/**
 * Wrap a rendered block in a code fence. The fence is what guarantees monospace — and what keeps
 * cell text INERT: model-authored cells are full of `|`, `*`, `_` and backticks that Discord would
 * otherwise render as live markdown, letting one unbalanced cell corrupt every line after it. The
 * one sequence that could still escape is a fence-closing backtick run inside a cell, which
 * `defuseFences` takes apart (the same defusal the tool-output card uses).
 */
function fence(body: string): string {
  return '```\n' + defuseFences(body) + '\n```';
}

/** Render one parsed table: a compact box while its cells stay short, a record list once they do
 *  not, fenced either way. */
function renderParsed(table: ParsedTable, maxWidth: number): string {
  const widths = columnWidths(table.rows, maxWidth);
  return fence(
    fitsGrid(table.rows, widths, maxWidth)
      ? renderGrid(table, widths)
      : renderRecords(table, maxWidth),
  );
}

/**
 * Re-render every table in `text` for Discord: box-drawing and markdown pipe tables become fenced
 * blocks at most ~`maxWidth` columns wide — a compact box, or a record list when the cells are
 * long prose. All other lines (and anything the author already fenced) pass through
 * byte-identical. Returns the input unchanged when no table is found, so callers can apply this
 * unconditionally.
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
      out.push(parsed ? renderParsed(parsed, maxWidth) : fence(block.join('\n')));
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
        out.push(renderParsed(parsed, maxWidth));
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
