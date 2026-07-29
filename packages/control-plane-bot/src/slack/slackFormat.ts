// The ONLY path wire-derived text may take into a Slack message.
//
// Slack parses `<@U…>`, `<#C…>`, `<!channel>`, `<!here>`, `<!everyone>` out of plain message
// text with no allowedMentions-style kill switch (unlike Discord, which needs an explicit opt-in
// per mention type). Daemon-sourced strings — summaries, command output, error text — are
// attacker-adjacent: anything a compromised or misbehaving daemon can put in a summary can ping
// `@everyone` in the workspace unless it is escaped before it ever reaches the Slack API. Once
// `<` is escaped to `&lt;`, none of those sequences can parse, because Slack's mention/control
// grammar keys off a raw `<` opening a special block — there is no other trigger character.
//
// `toMrkdwn` is meant to be the single entry point for wire-derived markdown. It sanitizes first
// and only ever emits its OWN `<...>` sequences afterward (for converted links) — and even those
// are gated on the url's scheme (`isSafeLinkUrl` below). Slack's link syntax and its mention/
// control syntax share the EXACT same `<...|...>` shape (`<url|label>` vs. `<!channel|x>`,
// `<@U…|x>`, `<#C…|x>`), so a `[label](url)` whose url is really `!channel`/`@U…`/`#C…` would
// render as a live mention, not a link, if the url were trusted blindly. Calling
// `sanitizeSlackText` twice on the same text would double-escape it (`&` → `&amp;` →
// `&amp;amp;`); nothing in this module does that, and any new caller must route through
// `toMrkdwn` (or `sanitizeSlackText` alone, exactly once) rather than composing the two.

import { chunkMessage } from '../discord/messageChunks.js';

/** Slack's own budgets, kept separate from `discord/messageChunks.ts`'s Discord constants —
 *  the two platforms cap text at different lengths for different reasons (block `text` object
 *  vs. message `content`), so sharing a number here would be a coincidence, not a contract. */
export const SLACK_LIMITS = {
  /** `section` block `text.text` (and most other block `text` objects) cap at 3000 chars. */
  SECTION_TEXT_MAX: 3000,
  /** `chat.postMessage` rejects a `blocks` array beyond this length. */
  BLOCKS_PER_MESSAGE_MAX: 50,
  /** Top-level `text` fallback field cap. */
  MESSAGE_TEXT_MAX: 40000,
  /** Slack's per-channel rate limit for `chat.postMessage` is ~1 msg/sec; callers posting a
   *  chunked series into one channel must space sends by at least this much or later chunks get
   *  rate-limited and arrive out of order (or not at all). */
  MIN_CHANNEL_SEND_INTERVAL_MS: 1000,
} as const;

/**
 * Escape the three characters Slack's message grammar treats as special: `&`, `<`, `>`. This is
 * Slack's own required escaping (documented for `chat.postMessage` `text`/mrkdwn fields), and it
 * is also the sanitization boundary — once `<` is escaped, `<!channel>`, `<@U…>`, `<#C…|name>`
 * etc. are inert literal text, because Slack has no OTHER way to open a mention or control
 * sequence. `&` is escaped first so the `&` introduced by escaping `<`/`>` is not itself
 * re-escaped into `&amp;lt;`.
 */
export function sanitizeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Delimiters for the stash used below, built from `\u` escapes rather than pasted as literal
 *  glyphs — an invisible private-use character silently mangled by an editor, diff, or encoding
 *  step would break every stash/unstash round-trip with no visible diff to catch it. The
 *  Unicode private-use area is realistically never present in wire text; a collision would only
 *  garble formatting output, never reopen the injection `sanitizeSlackText` already closed,
 *  since sanitize has already run over the FULL raw text (stashed spans included) before any
 *  placeholder exists. */
const STASH_OPEN = '';
const STASH_CLOSE = '';
const STASH_TOKEN = new RegExp(`${STASH_OPEN}(\\d+)${STASH_CLOSE}`, 'g');
const STASH_TOKEN_PROBE = new RegExp(`${STASH_OPEN}\\d+${STASH_CLOSE}`);

/** Pull a span out of the text under conversion and hand back a token to reinsert later. Used
 *  both for spans that must be left byte-for-byte alone (code fences/spans) and for spans that
 *  have ALREADY reached their final Slack syntax (converted links, headings, bold) — in both
 *  cases the point is to remove them from the string before the later, more general regexes
 *  (italic, strikethrough) get a chance to re-match characters inside them. */
function stash(store: string[], value: string): string {
  const token = `${STASH_OPEN}${store.length}${STASH_CLOSE}`;
  store.push(value);
  return token;
}

/** Reverse `stash`. Looped rather than a single pass because a stashed value can itself contain
 *  another token (e.g. an inline-code span stashed while sitting inside text that a later bold
 *  match wraps and re-stashes) — one `.replace` pass only resolves the outermost layer. Nesting
 *  is shallow by construction (fences/code are pulled first, so nothing after them can nest a
 *  code token inside a NEW code token), so this always terminates. */
function unstash(text: string, store: string[]): string {
  let result = text;
  while (STASH_TOKEN_PROBE.test(result)) {
    result = result.replace(STASH_TOKEN, (_match, index: string) => store[Number(index)] ?? '');
  }
  return result;
}

/** Schemes trusted enough to wrap in a live `<url|label>` — everything else renders as inert
 *  text. `https?://` and `mailto:` are the only two a Slack workspace ever legitimately links to
 *  from daemon-sourced text (a webpage, an email address); nothing in this codebase generates
 *  Slack's own `slack://` deep links or any other scheme. */
const LINK_URL_SCHEME_ALLOWLIST = /^(?:https?:\/\/|mailto:)/i;

/** Belt-and-braces on top of the allowlist above: even if a future scheme were added carelessly
 *  (e.g. a bare `//`-relative allowance), a url starting with one of Slack's own mention/control
 *  sigils must still never reach the `<url|label>` template. Redundant with the allowlist today —
 *  none of `!`, `@`, `#` can start a string that also matches `LINK_URL_SCHEME_ALLOWLIST` — but the
 *  two checks fail independently, so a bug in one doesn't silently remove the other's protection. */
const LINK_URL_MENTION_SIGIL = /^[!@#]/;

/** Whether `url` is safe to wrap in a live Slack `<url|label>` sequence. Anything that fails this
 *  is Slack's mention/control grammar in disguise (`!channel`, `@U…`, `#C…`) or some other scheme
 *  this codebase has no reason to trust, and must render as plain text instead. */
function isSafeLinkUrl(url: string): boolean {
  return LINK_URL_SCHEME_ALLOWLIST.test(url) && !LINK_URL_MENTION_SIGIL.test(url);
}

/**
 * Full pipeline for wire-derived markdown: sanitize first (see `sanitizeSlackText`), then rewrite
 * Discord/CommonMark-ish markup into Slack mrkdwn. This is the module's real entry point — call
 * this, not `sanitizeSlackText` directly, for anything that might contain markdown.
 *
 * Order is load-bearing, not stylistic:
 *   1. Sanitize the WHOLE raw string first, so every later step (including link generation) only
 *      ever works over already-inert text — a hostile `[x](<!everyone>)` cannot smuggle a raw
 *      `<` through, because by the time the link regex runs, that `<` is already `&lt;`.
 *   2. Pull code fences and inline code spans out into placeholders before any other conversion
 *      runs, so a bold/italic/link marker that happens to appear inside a code sample is never
 *      rewritten — Slack renders fenced/backtick spans verbatim, same as Discord.
 *   3. Headings and links are converted to their FINAL Slack syntax and immediately re-stashed —
 *      not left in the string — because both can legitimately end up containing a lone `*` or
 *      `_` (a heading's bold wrapper, a URL's query string) that the italic pass below would
 *      otherwise misinterpret as an emphasis marker and corrupt.
 *   4. Bold (`**x**` → `*x*`) is converted and stashed for the same reason: Slack's bold IS a
 *      single asterisk, so its own output would otherwise look like unclosed italic to the next
 *      step.
 *   5. Italic and strikethrough run last, over whatever plain text remains.
 */
export function toMrkdwn(markdown: string): string {
  const escaped = sanitizeSlackText(markdown);
  const stashed: string[] = [];
  const hold = (value: string): string => stash(stashed, value);

  // Fenced blocks first (greedy across lines), then inline spans in whatever's left — this
  // ordering keeps an inline-code regex from matching backticks that are actually fence markers.
  let out = escaped.replace(/```[\s\S]*?```/g, hold);
  out = out.replace(/`[^`\n]+`/g, hold);

  // Slack mrkdwn has no heading syntax; a bold line is the closest visual equivalent.
  out = out.replace(/^ {0,3}#{1,6}[ \t]+(.+)$/gm, (_match, body: string) =>
    hold(`*${body.trim()}*`),
  );

  // `[text](url)` → `<url|text>`, but ONLY when `isSafeLinkUrl(url)` passes. The url is taken
  // from the already-sanitized string, so any `<`/`>`/`&` it contained arrived as entities, not
  // live delimiters — that closes off one attack, but not this one: Slack's link syntax and its
  // mention/control syntax are the SAME `<...|...>` shape, so a url of `!channel`/`@U…`/`#C…`
  // needs no angle brackets of its own to become a live mention once wrapped. A url that fails the
  // check is rendered as inert text instead — still stashed, so a later pass can't re-mangle it.
  out = out.replace(/\[([^\]\n]*)\]\((\S+?)\)/g, (_match, label: string, url: string) =>
    isSafeLinkUrl(url) ? hold(`<${url}|${label}>`) : hold(`${label} (${url})`),
  );

  // '**bold**' → '*bold*' (Slack bold is single-asterisk). Stashed immediately — see doc comment.
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, (_match, body: string) => hold(`*${body}*`));

  // '*italic*' or '_italic_' → '_italic_'. Runs after bold is stashed, so the only single '*'
  // pairs left in the string are genuine CommonMark italics, not bold's leftovers.
  out = out.replace(
    /\*([^*\n]+?)\*|_([^_\n]+?)_/g,
    (_match, star: string | undefined, underscore: string | undefined) => `_${star ?? underscore}_`,
  );

  // '~~strike~~' → '~strike~'.
  out = out.replace(/~~([^~\n]+?)~~/g, (_match, body: string) => `~${body}~`);

  return unstash(out, stashed);
}

/**
 * Split `text` into chunks no larger than `budget` (default `SECTION_TEXT_MAX`, Slack's most
 * common block-text cap), respecting code-fence integrity the same way `discord/messageChunks.ts`
 * does. Reuses that module's `chunkMessage` core directly rather than re-implementing the
 * fence-balancing logic — its width is already parameterized via `options.max`, so this is an
 * import-only reuse, not a fork.
 *
 * `maxChunks` is set to effectively unlimited: `chunkMessage`'s default (4) exists to cap a
 * Discord DM flood and silently drops the remainder past that with a "(truncated)" marker. Slack
 * callers have their own message/block budgets (see `SLACK_LIMITS`) and must not lose content to
 * a Discord-specific flood guard they never asked for.
 */
export function slackChunks(
  text: string,
  budget: number = SLACK_LIMITS.SECTION_TEXT_MAX,
): string[] {
  return chunkMessage(text, { max: budget, maxChunks: Number.MAX_SAFE_INTEGER });
}
