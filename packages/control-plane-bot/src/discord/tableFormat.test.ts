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
    // Header separator only — markdown tables have exactly one.
    expect(lines.filter((l) => l.startsWith('├'))).toHaveLength(1);
  });

  it('does not fire on a stray pipe in prose (no separator line follows)', () => {
    const prose = 'use a | b syntax here\nand carry on';
    expect(formatTables(prose)).toBe(prose);
  });

  it('honors a custom width', () => {
    const out = formatTables(MD_TABLE, 60);
    for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
  });
});

// The card that motivated the record layout: a 2-column markdown table whose second column is
// whole sentences. Discord renders none of it, and a 40-column grid would give each sentence a
// third of a line. Kept verbatim as the primary fixture for that layout.
const PROSE_MD_TABLE = [
  '| Action | Detail |',
  '|---|---|',
  '| `probe_attention.py` -> `scripts/` | Self-contained, no relative imports - runs unchanged. |',
  "| `main.py` + `qwen3-gen-smoke.py` -> `scripts/smoke_generate.py` | Collapsed the duplicate; kept the thinking-split behavior, took `main.py`'s `dtype=` and its bounded token cap. |",
  '| `pyrightconfig.json` -> deleted | Folded into `[tool.pyright]`. If a `pyrightconfig.json` ever reappears it wins and the pyproject table is silently ignored. Added `extraPaths = ["src"]` so `steez_ttt` resolves before the editable install. |',
  '| `README.md`, `tasks/todo.md` | Updated the dangling paths the moves created. |',
  '| `.ruff_cache/` | Deleted - two stale ruff versions of pure garbage. |',
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
        '`probe_attention.py` -> `scripts/`',
        '  Self-contained, no relative imports -',
        '  runs unchanged.',
        '',
        '`main.py` + `qwen3-gen-smoke.py` ->',
        '`scripts/smoke_generate.py`',
        '  Collapsed the duplicate; kept the',
        '  thinking-split behavior, took',
        "  `main.py`'s `dtype=` and its bounded",
        '  token cap.',
        '',
        '`pyrightconfig.json` -> deleted',
        '  Folded into `[tool.pyright]`. If a',
        '  `pyrightconfig.json` ever reappears it',
        '  wins and the pyproject table is',
        '  silently ignored. Added `extraPaths =',
        '  ["src"]` so `steez_ttt` resolves',
        '  before the editable install.',
        '',
        '`README.md`, `tasks/todo.md`',
        '  Updated the dangling paths the moves',
        '  created.',
        '',
        '`.ruff_cache/`',
        '  Deleted - two stale ruff versions of',
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
      '| `probe_attention.py` -> `scripts/` | Self-contained, no relative imports so it runs unchanged. | platform |',
      '| `pyrightconfig.json` -> deleted | Folded into the pyproject table; a stray config file would silently win. | tooling |',
    ].join('\n');
    expect(formatTables(three)).toBe(
      [
        '```',
        'ACTION: `probe_attention.py` ->',
        '        `scripts/`',
        'DETAIL: Self-contained, no relative',
        '        imports so it runs unchanged.',
        'OWNER:  platform',
        '',
        'ACTION: `pyrightconfig.json` -> deleted',
        'DETAIL: Folded into the pyproject table;',
        '        a stray config file would',
        '        silently win.',
        'OWNER:  tooling',
        '```',
      ].join('\n'),
    );
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

  it('defuses a cell that would otherwise close the fence around it', () => {
    const table = ['| Cmd | Note |', '| --- | --- |', '| ``` | ends a fence |'].join('\n');
    const out = formatTables(table);
    // Exactly the opening and closing fences: the cell's backticks can no longer terminate ours,
    // and the characters are still all there.
    expect(out.match(/```/g)).toHaveLength(2);
    expect(out).toContain('`' + String.fromCharCode(0x200b) + '``');
  });
});
