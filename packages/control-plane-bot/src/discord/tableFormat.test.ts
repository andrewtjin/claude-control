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
