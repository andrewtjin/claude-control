import { describe, it, expect } from 'vitest';
import { SLACK_LIMITS, sanitizeSlackText, toMrkdwn, slackChunks } from './slackFormat.js';
import { layeredBar, emojiTrack } from '../discord/richFormat.js';

describe('SLACK_LIMITS', () => {
  // Pinned constants: a silent change here would desync every caller's chunk/block budgeting
  // from what Slack's API actually enforces.
  it('matches the pinned Slack budgets, never the Discord ones', () => {
    expect(SLACK_LIMITS).toEqual({
      SECTION_TEXT_MAX: 3000,
      BLOCKS_PER_MESSAGE_MAX: 50,
      MESSAGE_TEXT_MAX: 40000,
      MIN_CHANNEL_SEND_INTERVAL_MS: 1000,
    });
  });
});

describe('sanitizeSlackText', () => {
  it('escapes & < > so Slack cannot parse a mention/control sequence out of plain text', () => {
    expect(sanitizeSlackText('<!channel>')).toBe('&lt;!channel&gt;');
    expect(sanitizeSlackText('<!here>')).toBe('&lt;!here&gt;');
    expect(sanitizeSlackText('<!everyone>')).toBe('&lt;!everyone&gt;');
    expect(sanitizeSlackText('<@U123>')).toBe('&lt;@U123&gt;');
    expect(sanitizeSlackText('<#C123|general>')).toBe('&lt;#C123|general&gt;');
  });

  it('escapes & first so its own escaping is not re-escaped', () => {
    // If '<' were escaped before '&', the '&' introduced by '&lt;' would get re-escaped into
    // '&amp;lt;' — wrong output, and a second pass would then double-escape real ampersands too.
    expect(sanitizeSlackText('<')).toBe('&lt;');
    expect(sanitizeSlackText('a & b')).toBe('a &amp; b');
  });

  it('leaves already-escaped entity text alone as literal characters, never double-escaping it', () => {
    // Someone typed the literal string "&lt;" meaning to show those four characters, not a "<".
    // sanitize must treat it as opaque text: only the bare '&' in it is special.
    expect(sanitizeSlackText('&lt;')).toBe('&amp;lt;');
    expect(sanitizeSlackText('&amp;')).toBe('&amp;amp;');
  });

  it('is a no-op on text with none of the special characters', () => {
    expect(sanitizeSlackText('plain daemon output, no markup')).toBe(
      'plain daemon output, no markup',
    );
  });
});

describe('toMrkdwn — hostile input', () => {
  it('neutralizes every Slack mention/control sequence embedded in wire text', () => {
    const hostile = 'ping <!channel> and <!here> and <!everyone>, cc <@U123> in <#C123|general>';
    const out = toMrkdwn(hostile);
    expect(out).not.toMatch(/<!channel>|<!here>|<!everyone>|<@U123>|<#C123\|general>/);
    expect(out).toBe(
      'ping &lt;!channel&gt; and &lt;!here&gt; and &lt;!everyone&gt;, cc &lt;@U123&gt; in &lt;#C123|general&gt;',
    );
  });

  it('regression: a hostile url already wrapped in real angle brackets never emits one live (this case is pre-neutralized by sanitize before the link regex ever runs, so it is not the exploit surface — see the describe block below for that)', () => {
    const out = toMrkdwn('[click](<!everyone>)');
    expect(out).not.toContain('<!everyone>');
  });

  it('does not double-escape text that already contains literal entities', () => {
    expect(toMrkdwn('already &lt;escaped&gt;')).toBe('already &amp;lt;escaped&amp;gt;');
  });
});

describe('toMrkdwn — link url scheme allowlist (the actual exploit surface)', () => {
  // Slack's mention/control grammar is `<!channel|label>`, `<@U…|label>`, `<#C…|label>` — the
  // EXACT shape toMrkdwn's link conversion emits for `[label](url)`. None of these need a literal
  // `<`/`>` in the source markdown (sanitizeSlackText has nothing to escape), so a url of
  // `!channel`/`@U…`/`#C…` reaching the `<url|label>` template unvalidated becomes a live mention.
  // This is the structural check that matters: no `<` immediately followed by `!`/`@`/`#` anywhere
  // in the output, regardless of what specific shape a future bypass would take.
  const HOSTILE_LINK_URLS = ['!channel', '!here', '!everyone', '@U024BE7LH', '#C024BE7LR|general'];

  it.each(HOSTILE_LINK_URLS)('renders [x](%s) as inert text, never a live mention', (url) => {
    const out = toMrkdwn(`[x](${url})`);
    expect(out).not.toMatch(/<[!@#]/);
  });

  // Regressions for the pre-escaped variants: these could only ever pass (the angle brackets are
  // gone before the link regex runs), so they guard against a future change reintroducing raw
  // brackets rather than against the scheme-allowlist bypass itself.
  it.each(HOSTILE_LINK_URLS)(
    'regression: [x](<%s>) (pre-escaped by sanitize) also never emits a live mention',
    (url) => {
      const out = toMrkdwn(`[x](<${url}>)`);
      expect(out).not.toMatch(/<[!@#]/);
    },
  );

  it('still converts a legitimate https link to Slack <url|label> syntax', () => {
    expect(toMrkdwn('[docs](https://example.com)')).toBe('<https://example.com|docs>');
  });

  it('still converts a legitimate mailto link to Slack <url|label> syntax', () => {
    expect(toMrkdwn('[me](mailto:a@example.com)')).toBe('<mailto:a@example.com|me>');
  });

  it('renders a link with an untrusted scheme as inert text instead of a live link', () => {
    const out = toMrkdwn('[x](javascript:alert(1))');
    expect(out).not.toMatch(/<javascript:/);
    expect(out).toContain('x (javascript:alert(1))');
  });
});

describe('toMrkdwn — markdown conversion matrix', () => {
  it('converts **bold** to Slack single-asterisk bold', () => {
    expect(toMrkdwn('**bold**')).toBe('*bold*');
  });

  it('converts *italic* and _italic_ to Slack underscore italic', () => {
    expect(toMrkdwn('*italic*')).toBe('_italic_');
    expect(toMrkdwn('_italic_')).toBe('_italic_');
  });

  it('does not mistake bold output for a later italic match', () => {
    // Slack bold IS single-asterisk; if the italic pass re-matched it, '**x**' would come out
    // '_*x*_' instead of '*x*'.
    expect(toMrkdwn('**x** and *y*')).toBe('*x* and _y_');
  });

  it('converts ~~strike~~ to Slack single-tilde strikethrough', () => {
    expect(toMrkdwn('~~gone~~')).toBe('~gone~');
  });

  it('converts [text](url) to Slack <url|text> link syntax', () => {
    expect(toMrkdwn('[Anthropic](https://anthropic.com)')).toBe(
      '<https://anthropic.com|Anthropic>',
    );
  });

  it("does not let a link's underscores get eaten by the italic pass", () => {
    const out = toMrkdwn('[docs](https://example.com/a_b_c)');
    expect(out).toBe('<https://example.com/a_b_c|docs>');
  });

  it('converts headings to a bold line, with no Slack heading syntax', () => {
    expect(toMrkdwn('# Title')).toBe('*Title*');
    expect(toMrkdwn('### Sub')).toBe('*Sub*');
  });

  it('does not let heading output get re-wrapped by the italic pass', () => {
    expect(toMrkdwn('# Title')).not.toContain('_');
  });

  it('passes inline code through untouched (aside from the universal & < > escape)', () => {
    expect(toMrkdwn('`a < b && c`')).toBe('`a &lt; b &amp;&amp; c`');
    // Markdown syntax characters inside code must not be converted.
    expect(toMrkdwn('`**not bold**`')).toBe('`**not bold**`');
  });

  it('passes fenced code blocks through untouched (aside from the universal escape)', () => {
    const fence = '```js\nif (a < b) { return **x**; }\n```';
    const out = toMrkdwn(fence);
    expect(out).toBe('```js\nif (a &lt; b) { return **x**; }\n```');
  });

  it('handles a mixed line combining several conversions at once', () => {
    const out = toMrkdwn('# Report\n**status**: *ok*, see [docs](https://x.test) — ~~old~~');
    expect(out).toBe('*Report*\n*status*: _ok_, see <https://x.test|docs> — ~old~');
  });
});

describe('slackChunks', () => {
  it('returns a single chunk when text already fits the budget', () => {
    expect(slackChunks('short')).toEqual(['short']);
    const exact = 'x'.repeat(SLACK_LIMITS.SECTION_TEXT_MAX);
    expect(slackChunks(exact)).toEqual([exact]);
  });

  it('splits text past the default budget into multiple sendable chunks', () => {
    const chunks = slackChunks('x'.repeat(SLACK_LIMITS.SECTION_TEXT_MAX + 1));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_LIMITS.SECTION_TEXT_MAX);
    }
  });

  it('respects a custom budget', () => {
    const chunks = slackChunks('y'.repeat(500), 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  it('never drops content past a fixed chunk count the way the Discord chunker does', () => {
    // chunkMessage's own default maxChunks (4) would truncate this and append a marker; Slack
    // callers must get every chunk back instead.
    const big = Array.from({ length: 20 }, (_, i) => `line ${i} ${'z'.repeat(150)}`).join('\n');
    const chunks = slackChunks(big, 200);
    expect(chunks.join('\n')).not.toContain('truncated');
    expect(chunks.join('')).toContain('line 19');
  });

  it('keeps code fences balanced across a chunk boundary that spans a fence', () => {
    const codeBody = Array.from({ length: 60 }, (_, i) => `console.log(${i});`).join('\n');
    const text = `intro text\n\`\`\`js\n${codeBody}\n\`\`\`\noutro text`;
    const chunks = slackChunks(text, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = (chunk.match(/```/g) ?? []).length;
      expect(fences % 2, `unbalanced fence in chunk: ${chunk.slice(0, 60)}…`).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(300);
    }
  });
});

describe('unicode bars survive the pipeline untouched', () => {
  it('sanitizeSlackText does not mangle an emoji progress bar', () => {
    const bar = layeredBar(65);
    expect(sanitizeSlackText(bar)).toBe(bar);
  });

  it('toMrkdwn does not mangle an emoji progress bar embedded in prose', () => {
    const bar = layeredBar(40);
    const out = toMrkdwn(`usage: ${bar} 40%`);
    expect(out).toBe(`usage: ${bar} 40%`);
  });

  it('toMrkdwn does not mangle an emoji timeline track', () => {
    const track = emojiTrack([{ atMs: 1000, kind: 'session' }], 0, 10_000);
    expect(toMrkdwn(track)).toBe(track);
  });
});
