import { describe, it, expect } from 'vitest';
import { formatTables, DEFAULT_TABLE_WIDTH } from './tableFormat.js';

// The real card that motivated this module: a terminal-sized comparison table (88 columns)
// that a phone-width Discord surface shredded. Kept verbatim as the primary fixture.
const WIDE_BOX_TABLE = [
  '┌───────────────────────────────────────────────────┬────────────────────────────────────┐',
  '│                     Inferred                      │             Confirmed              │',
  '├───────────────────────────────────────────────────┼────────────────────────────────────┤',
  "│ Target 'wss://cctl.andrewtjin.com'                │ exact match                        │",
  '├───────────────────────────────────────────────────┼────────────────────────────────────┤',
  '│ Merge #6 before Step 3                            │ exact match                        │',
  '├───────────────────────────────────────────────────┼────────────────────────────────────┤',
  '│ Precedence --relay > env > config.json > built-in │ matches what #6 shipped            │',
  '├───────────────────────────────────────────────────┼────────────────────────────────────┤',
  '│ "Rebase onto post-#6 main"                        │ I branched off 4e16ee6; equivalent │',
  '└───────────────────────────────────────────────────┴────────────────────────────────────┘',
].join('\n');

/** All of column `col`'s text in a rendered table, wrapped fragments rejoined, whitespace
 *  stripped — the roundtrip form for asserting no content was lost or reordered. */
function columnText(rendered: string, col: number): string {
  return rendered
    .split('\n')
    .filter((l) => l.startsWith('│'))
    .map((l) => (l.split('│')[col + 1] ?? '').trim())
    .join('')
    .replace(/\s+/g, '');
}

describe('formatTables — box-drawing input', () => {
  it('reflows a terminal-wide table to fit the phone width, fenced', () => {
    const out = formatTables(WIDE_BOX_TABLE);
    const lines = out.split('\n');
    expect(lines[0]).toBe('```');
    expect(lines[lines.length - 1]).toBe('```');
    // Every rendered line fits the target — Discord wraps TEXT we chose, never the borders.
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(DEFAULT_TABLE_WIDTH);
    expect(lines[1]?.startsWith('┌')).toBe(true);
    expect(lines[1]).toContain('┬');
    expect(lines[lines.length - 2]?.startsWith('└')).toBe(true);
  });

  it('loses no cell content when wrapping — full per-column roundtrip', () => {
    const out = formatTables(WIDE_BOX_TABLE);
    expect(columnText(out, 0)).toBe(
      [
        'Inferred',
        "Target 'wss://cctl.andrewtjin.com'",
        'Merge #6 before Step 3',
        'Precedence --relay > env > config.json > built-in',
        '"Rebase onto post-#6 main"',
      ]
        .join('')
        .replace(/\s+/g, ''),
    );
    expect(columnText(out, 1)).toBe(
      [
        'Confirmed',
        'exact match',
        'exact match',
        'matches what #6 shipped',
        'I branched off 4e16ee6; equivalent',
      ]
        .join('')
        .replace(/\s+/g, ''),
    );
  });

  it('keeps the source row separators (one between every row here)', () => {
    const out = formatTables(WIDE_BOX_TABLE);
    const separators = out.split('\n').filter((l) => l.startsWith('├'));
    expect(separators).toHaveLength(4); // 5 rows, a separator after each but the last
  });

  it('keeps a separator between every body row for a fully-separated box source (3 rows)', () => {
    // A box source states its own gaps and the render mirrors them exactly — unlike markdown,
    // which states none. A source ruled at every gap therefore comes back ruled at every gap,
    // and narrowing the columns to their natural width must not cost a single rule.
    const threeRows = [
      '┌─────┬─────┬─────┐',
      '│  A  │  A  │  A  │',
      '├─────┼─────┼─────┤',
      '│ A   │ A   │ A   │',
      '├─────┼─────┼─────┤',
      '│ A   │ A   │ A   │',
      '└─────┴─────┴─────┘',
    ].join('\n');
    const out = formatTables(threeRows);
    expect(out).toBe(
      [
        '```',
        '┌───┬───┬───┐',
        '│ A │ A │ A │',
        '├───┼───┼───┤',
        '│ A │ A │ A │',
        '├───┼───┼───┤',
        '│ A │ A │ A │',
        '└───┴───┴───┘',
        '```',
      ].join('\n'),
    );
  });

  it('renders a table that already fits at its natural width', () => {
    const narrow = ['┌────┬────┐', '│ ab │ cd │', '├────┼────┤', '│ ef │ gh │', '└────┴────┘'].join(
      '\n',
    );
    const out = formatTables(narrow);
    expect(out).toBe('```\n' + narrow + '\n```');
  });

  it('preserves prose around a table and returns table-free text byte-identical', () => {
    const prose = 'no tables here\njust lines of text\n- and a list';
    expect(formatTables(prose)).toBe(prose);
    const mixed = `intro line\n${WIDE_BOX_TABLE}\noutro line`;
    const out = formatTables(mixed);
    expect(out.startsWith('intro line\n```')).toBe(true);
    expect(out.endsWith('```\noutro line')).toBe(true);
  });

  it('fences an inconsistent box run verbatim instead of guessing at a parse', () => {
    const broken = ['│ one │ two │', '│ three │'].join('\n');
    expect(formatTables(broken)).toBe('```\n' + broken + '\n```');
  });

  it('leaves content inside an existing code fence exactly as authored', () => {
    const fenced = '```\n' + WIDE_BOX_TABLE + '\n```';
    expect(formatTables(fenced)).toBe(fenced);
  });

  it('leaves a lone horizontal rule and heavy/double box art untouched', () => {
    expect(formatTables('──────────')).toBe('──────────');
    const heavy = '╔════╦════╗\n║ a  ║ b  ║\n╚════╩════╝';
    expect(formatTables(heavy)).toBe(heavy);
  });

  it('hard-splits an unbreakable token wider than its column, losing nothing', () => {
    const url = 'https://very-long-hostname.example.com/deep/path/segment/file.tar.gz';
    const table = [
      '┌──────────────────────────────────────────────────────────────────────┬────┐',
      `│ ${url} │ ok │`,
      '└──────────────────────────────────────────────────────────────────────┴────┘',
    ].join('\n');
    const out = formatTables(table);
    for (const line of out.split('\n'))
      expect(line.length).toBeLessThanOrEqual(DEFAULT_TABLE_WIDTH);
    expect(columnText(out, 0)).toBe(url);
  });
});

describe('formatTables — markdown pipe input', () => {
  const MD_TABLE = [
    '| Flag | Meaning |',
    '| --- | --- |',
    '| --auto-switch | hop accounts automatically |',
    '| --greedy | burn the soonest-expiring budget |',
  ].join('\n');

  it('renders a markdown table (which Discord ignores) as a fenced box', () => {
    const out = formatTables(MD_TABLE);
    const lines = out.split('\n');
    expect(lines[0]).toBe('```');
    expect(lines[1]?.startsWith('┌')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(DEFAULT_TABLE_WIDTH);
    expect(columnText(out, 0)).toBe('Flag--auto-switch--greedy'.replace(/\s+/g, ''));
    // Markdown has exactly one delimiter row (header/body), but that delimiter marks where the
    // HEADER ends, not how many separators the grid gets: every row still sits on its own line
    // in the source, so the render separates every gap — one after the header, one between the
    // two body rows.
    expect(lines.filter((l) => l.startsWith('├'))).toHaveLength(2);
  });

  it('separates every body row, not just the header — a markdown table has no way to mark a gap as unseparated', () => {
    // With a rule only under the header, every body row past the first sits flush against the
    // next and the three of them read as one three-line row. A single-character cell keeps the
    // box narrow enough that nothing wraps, isolating the rule count from the width/wrap
    // behavior covered elsewhere.
    const threeBodyRows = [
      '| Col | Val |',
      '| --- | --- |',
      '| A | A |',
      '| A | A |',
      '| A | A |',
    ].join('\n');
    const out = formatTables(threeBodyRows);
    const lines = out.split('\n');
    // 4 rows total (header + 3 body) means 3 gaps, every one of them separated.
    expect(lines.filter((l) => l.startsWith('├'))).toHaveLength(3);
    // And no two data rows are adjacent without a separator between them.
    const dataOrSep = lines.filter((l) => l.startsWith('│') || l.startsWith('├'));
    for (let i = 0; i + 1 < dataOrSep.length; i++) {
      const both = [dataOrSep[i], dataOrSep[i + 1]];
      expect(both.every((l) => l?.startsWith('│'))).toBe(false);
    }
  });

  it('does not fire on a stray pipe in prose (no separator line follows)', () => {
    const prose = 'use a | b syntax here\nand carry on';
    expect(formatTables(prose)).toBe(prose);
  });

  it('honors a custom width', () => {
    const out = formatTables(MD_TABLE, { maxWidth: 60 });
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
  });
});

describe('formatTables — budget', () => {
  /** A markdown table whose cells are short enough to stay a grid, so the only thing that grows
   *  with `bodyRows` is the row count and the rules between them. */
  const mdTable = (bodyRows: number): string =>
    [
      '| Account | Plan | Left |',
      '| --- | --- | --- |',
      ...Array.from({ length: bodyRows }, (_, i) => `| account-${i} | max20x | ${i}% |`),
    ].join('\n');

  it('rules every gap while the result fits the budget', () => {
    const out = formatTables(mdTable(3), { budget: 4096 });
    expect(out.split('\n').filter((l) => l.startsWith('├'))).toHaveLength(3);
  });

  it('drops the rules to a single header one once they no longer fit', () => {
    const source = mdTable(20);
    const ruled = formatTables(source);
    const budgeted = formatTables(source, { budget: ruled.length - 1 });
    expect(budgeted.length).toBeLessThan(ruled.length);
    // Down to the delimiter's own gap, and not one rule further: the header must stay divided
    // from the body even when there is no room for anything else.
    expect(budgeted.split('\n').filter((l) => l.startsWith('├'))).toHaveLength(1);
  });

  it('keeps every row when the rules are what had to go', () => {
    const source = mdTable(20);
    const budgeted = formatTables(source, { budget: 1024 });
    expect(budgeted.length).toBeLessThanOrEqual(1024);
    for (let i = 0; i < 20; i++) expect(budgeted).toContain(`account-${i}`);
  });

  it('leaves a box source ruled as it was drawn even under a budget it overruns', () => {
    // A box source states its gaps, so shedding them would be dropping information the sender
    // supplied — a budget buys back what this module chose to add, never what it was given.
    const box = [
      '┌─────┬─────┐',
      '│ a   │ b   │',
      '├─────┼─────┤',
      '│ c   │ d   │',
      '├─────┼─────┤',
      '│ e   │ f   │',
      '└─────┴─────┘',
    ].join('\n');
    const out = formatTables(box, { budget: 1 });
    expect(out.split('\n').filter((l) => l.startsWith('├'))).toHaveLength(2);
  });

  it('is unchanged by a budget it never reaches', () => {
    expect(formatTables(mdTable(2), { budget: 4096 })).toBe(formatTables(mdTable(2)));
  });
});

// The shape that motivated the record layout: a 2-column markdown table whose second column is
// whole sentences. Discord renders none of it, and a 40-column grid would give each sentence a
// third of a line. Synthetic file names — the fixture is about the SHAPE (code spans in the first
// cell, a paragraph in the second), not about any particular repository.
const PROSE_MD_TABLE = [
  '| Action | Detail |',
  '|---|---|',
  '| `widget.ts` -> `src/parts/` | Self-contained, no relative imports - moves unchanged. |',
  "| `loader.ts` + `loader-old.ts` -> `src/parts/loader.ts` | Collapsed the duplicate; kept the streaming path, took the older file's bounded retry cap. |",
  '| `legacy.config.json` -> deleted | Folded into the package config. A stray `legacy.config.json` would win over it and the merged settings would be ignored without a word. Added `roots = ["src"]` so `example_pkg` resolves before the local install. |',
  '| `README.md`, `tasks/todo.md` | Updated the dangling paths the moves created. |',
  '| `.cache/` | Deleted - two stale build caches of pure garbage. |',
].join('\n');

/** Every rendered character that is not a fence or layout whitespace — the roundtrip form for
 *  asserting a record layout dropped nothing and reordered nothing. */
function recordText(rendered: string): string {
  return rendered
    .split('\n')
    .filter((l) => l !== '```')
    .join('')
    .replace(/\s+/g, '');
}

describe('formatTables — long-cell tables render as records, not a grid', () => {
  it('renders the prose table as one record per row', () => {
    expect(formatTables(PROSE_MD_TABLE)).toBe(
      [
        '```',
        'Action',
        '  Detail',
        '',
        '`widget.ts` -> `src/parts/`',
        '  Self-contained, no relative imports -',
        '  moves unchanged.',
        '',
        '`loader.ts` + `loader-old.ts` ->',
        '`src/parts/loader.ts`',
        '  Collapsed the duplicate; kept the',
        "  streaming path, took the older file's",
        '  bounded retry cap.',
        '',
        '`legacy.config.json` -> deleted',
        '  Folded into the package config. A',
        '  stray `legacy.config.json` would win',
        '  over it and the merged settings would',
        '  be ignored without a word. Added',
        '  `roots = ["src"]` so `example_pkg`',
        '  resolves before the local install.',
        '',
        '`README.md`, `tasks/todo.md`',
        '  Updated the dangling paths the moves',
        '  created.',
        '',
        '`.cache/`',
        '  Deleted - two stale build caches of',
        '  pure garbage.',
        '```',
      ].join('\n'),
    );
  });

  it('keeps every record line inside the width budget', () => {
    for (const line of formatTables(PROSE_MD_TABLE).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(DEFAULT_TABLE_WIDTH);
    }
  });

  it('loses no cell content and keeps source order — full roundtrip', () => {
    // Header row included: with two fields it renders as the first record rather than vanishing.
    const cells = PROSE_MD_TABLE.split('\n')
      .filter((l) => !/^\|?[\s:|-]+\|?$/.test(l))
      .flatMap((l) => l.split('|').slice(1, -1));
    expect(recordText(formatTables(PROSE_MD_TABLE))).toBe(cells.join('').replace(/\s+/g, ''));
  });

  it('labels each field past two columns, taking the labels from the header row', () => {
    const three = [
      '| Action | Detail | Owner |',
      '|---|---|---|',
      '| `widget.ts` -> `src/parts/` | Self-contained, no relative imports so it moves unchanged. | platform |',
      '| `legacy.config.json` -> deleted | Folded into the package config; a stray file would silently win. | tooling |',
    ].join('\n');
    expect(formatTables(three)).toBe(
      [
        '```',
        'ACTION: `widget.ts` -> `src/parts/`',
        'DETAIL: Self-contained, no relative',
        '        imports so it moves unchanged.',
        'OWNER:  platform',
        '',
        'ACTION: `legacy.config.json` -> deleted',
        'DETAIL: Folded into the package config;',
        '        a stray file would silently win.',
        'OWNER:  tooling',
        '```',
      ].join('\n'),
    );
  });

  it('leaves a blank header cell unlabeled instead of printing a bare colon', () => {
    // `| | Tradeoff | Recommendation |` is a common idiom: the corner names nothing, so it must
    // pad to the label column rather than label every record with a lone `:`.
    const blankCorner = [
      '| | Tradeoff | Recommendation |',
      '|---|---|---|',
      '| Option A | Costs more up front, but it avoids a rewrite in the next quarter. | Take it |',
      '| Option B | Cheaper today, and the rewrite lands squarely on the next team. | Skip it |',
    ].join('\n');
    const lines = formatTables(blankCorner).split('\n');
    expect(lines[1]).toBe('                Option A');
    expect(lines[2]).toBe('TRADEOFF:       Costs more up front, but');
  });

  it('drops the grid when the columns cannot be squeezed to the target width', () => {
    // Twenty one-word cells: no cell wraps at all, so the height gate never fires, yet every
    // column sits at its floor and the box still renders past 100 columns — the shredded grid
    // this module exists to replace. Width has to gate the layout too.
    const columns = 20;
    const wide = [
      `| ${Array.from({ length: columns }, (_, i) => `c${i}`).join(' | ')} |`,
      `|${'---|'.repeat(columns)}`,
      `| ${Array.from({ length: columns }, (_, i) => `v${i}`).join(' | ')} |`,
    ].join('\n');
    const out = formatTables(wide);
    expect(out).not.toContain('┌');
    for (const line of out.split('\n'))
      expect(line.length).toBeLessThanOrEqual(DEFAULT_TABLE_WIDTH);
    expect(out).toContain('C19: v19');
  });

  it('hard-splits an astral token on code points, never through a surrogate pair', () => {
    // A record wraps at `maxWidth - lead.length`, which is odd whenever the padded label is — and
    // a UTF-16 slice at an odd offset lands INSIDE an emoji, replacing it with two broken halves.
    const glyph = '\u{1F600}';
    const table = [
      '| Label | Detail |',
      '|---|---|',
      `| ${glyph.repeat(40)} | ${'a sentence long enough to force the record layout '.repeat(3)}|`,
    ].join('\n');
    const out = formatTables(table);
    expect([...out].filter((c) => c === glyph)).toHaveLength(40);
    // Nothing but complete pairs: a lone surrogate is what renders as U+FFFD.
    expect(out.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')).not.toMatch(/[\uD800-\uDFFF]/);
  });

  it('never eats a first DATA row as labels when the source declared no header', () => {
    const long = (n: string): string =>
      `${n} cell that runs on well past any column a phone-width grid could give it`;
    const headerless = [
      '┌──────┬──────┬──────┐',
      `│ ${long('first')} │ ${long('second')} │ ${long('third')} │`,
      `│ ${long('fourth')} │ ${long('fifth')} │ ${long('sixth')} │`,
      '└──────┴──────┴──────┘',
    ].join('\n');
    const blocks = formatTables(headerless)
      .split('\n')
      .filter((l) => l !== '```')
      .join('\n')
      .split('\n\n');
    // Two rows in, two records out — the first row is data, not a legend.
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.startsWith('first cell')).toBe(true);
    expect(formatTables(headerless)).not.toContain('FIRST');
  });

  it('keeps the grid for a table whose cells stay short (the boundary the layout turns on)', () => {
    // The 88-column fixture squeezes hard but its cells are still labels, not paragraphs.
    expect(formatTables(WIDE_BOX_TABLE)).toContain('┌');
    expect(formatTables(PROSE_MD_TABLE)).not.toContain('┌');
  });

  it('defuses a fence-closing backtick run of any length', () => {
    // Three is the fence itself; four is the idiom for fencing a block that CONTAINS a fence, so
    // a longer run is the case that matters — defusing only the leading three would leave the
    // rest adjacent to the backticks just emitted and rebuild a ``` inside the body.
    const zeroWidthSpace = String.fromCharCode(0x200b);
    for (const run of ['```', '````', '`````', '``````']) {
      const table = ['| Cmd | Note |', '| --- | --- |', `| ${run} | ends a fence |`].join('\n');
      const out = formatTables(table);
      // Exactly the opening and closing fences: nothing in the body can terminate ours.
      expect(out.match(/```/g)).toHaveLength(2);
      const body = out.split('\n').slice(1, -1).join('\n');
      // Every backtick is still there — the defusal separates them, it never drops them.
      expect(body.match(/`/g)).toHaveLength(run.length);
      expect(body).toContain([...run].join(zeroWidthSpace));
    }
  });
});
