// Terminal-safe text: the single authority for stripping bytes a terminal INTERPRETS rather than
// prints out of an operator- or filesystem-controlled string (an account label, a folder path)
// before it is rendered on any cctl surface.
//
// Account labels come from `accounts add`/`accounts rename` and folder names come from the
// filesystem, so on a shared box neither is trustworthy. Both can carry:
//   - C0/C1/DEL controls, including ESC (the CSI/OSC lead-in) — an SGR escape could recolor or
//     retitle a window or hide text, and a newline/carriage-return could forge extra output lines
//     (a fabricated "[system] ..." directive on its own line);
//   - the Unicode bidirectional/format controls (LRM/RLM and the Arabic letter mark U+061C, the
//     embeddings/overrides U+202A-202E, the isolates U+2066-2069, and the BOM U+FEFF) that let a
//     right-to-left run reorder a displayed path so what the eye reads is not what was matched;
//   - the line and paragraph separators U+2028/U+2029, which many renderers break a line on (the
//     same forged-line hazard as a newline);
//   - the invisible characters that hide text: zero-width space U+200B, the word joiner and
//     invisible operators U+2060-2064, the deprecated format controls U+206A-206F, and the tag
//     characters U+E0000-E007F (which can spell out a hidden ASCII message). The zero-width
//     non-joiner/joiner U+200C/U+200D are KEPT: they shape Persian and Indic text and join emoji
//     sequences, move nothing and forge nothing, and stripping them would mangle real labels.
//
// This strips all of it to plain, left-to-right, printable text. Removals are zero-width or
// interpreted bytes, never visible columns, so a kept value's width is unchanged and it still
// aligns under a renderer's plain-text padding. Idempotent.
//
// TWO consumers must agree byte-for-byte: cctl-side renderers (the CLI re-exports
// {@link sanitizeTerminalText} rather than re-deriving the same ranges) and the enforcement guard,
// a dependency-free CommonJS hook Claude Code spawns per prompt that cannot import this module and
// so EMBEDS the compiled source via {@link embeddableSanitizeSource}. For that embedding to be
// sound, {@link sanitizeTerminalText} must reference nothing at module scope — no imports, no
// module constants, no sibling helpers; its pattern is declared INSIDE its body. A colocated test
// evals the embedded copy and proves it agrees with the live function, the same way folderPath.ts
// guards its embedded canonicalizer. Do not hoist the pattern to module scope; that silently
// breaks the hook.

/**
 * Strip every terminal-interpreted control from a label or folder path: C0/C1/DEL (which includes
 * the ESC that begins an SGR/OSC sequence and the newline/CR that would forge a line), the line and
 * paragraph separators (U+2028/U+2029), the Unicode bidi/format controls (U+061C, U+200E/F,
 * U+202A-202E, U+2066-2069, U+FEFF), and the invisible characters that hide text (U+200B,
 * U+2060-2064, U+206A-206F, the tag block U+E0000-E007F). The result is plain, left-to-right,
 * printable text safe to color, pad, and write to any terminal surface, and safe to interpolate
 * into a hook decision string a terminal or model will read. Idempotent.
 *
 * SELF-CONTAINED BY CONTRACT (see file header): references only its parameter and a pattern
 * declared in its own body, so `sanitizeTerminalText.toString()` is a complete, embeddable program.
 */
export function sanitizeTerminalText(value: string): string {
  // Assembled from string parts (not a regex literal) inside the body for three reasons: the
  // function stays self-contained and embeddable (references nothing at module scope), the \u
  // escapes stay visible in source — a regex literal here would be reformatted into the raw
  // invisible control characters it exists to strip — and building the pattern from strings keeps
  // the control-char ranges out of a statically-analyzable regex literal.
  const unsafe = new RegExp(
    [
      '[\\u0000-\\u001f\\u007f-\\u009f]', // C0 controls + DEL + C1 controls (incl. ESC, CR, LF)
      '[\\u2028\\u2029]', // LINE SEPARATOR / PARAGRAPH SEPARATOR
      '[\\u061c\\u200e\\u200f]', // ALM / LRM / RLM
      '\\u200b', // ZERO WIDTH SPACE (ZWNJ/ZWJ U+200C/D are kept: they shape text and emoji)
      '[\\u2060-\\u2064]', // WORD JOINER + the invisible operators
      '[\\u202a-\\u202e]', // LRE RLE PDF LRO RLO
      '[\\u2066-\\u2069]', // LRI RLI FSI PDI
      '[\\u206a-\\u206f]', // the deprecated format controls
      '\\ufeff', // ZERO WIDTH NO-BREAK SPACE / BOM
      '[\\u{e0000}-\\u{e007f}]', // the tag characters
    ].join('|'),
    'gu',
  );
  return value.replace(unsafe, '');
}

/**
 * The embeddable source of {@link sanitizeTerminalText}, for the enforcement hook script.
 *
 * Returns a program string that, when run in an empty scope, defines `sanitizeTerminalText` as a
 * local. Because the function is self-contained, the emitted text carries everything it needs; the
 * colocated test proves the embedded copy still agrees with the live one, which is what stops the
 * two copies drifting.
 */
export function embeddableSanitizeSource(): string {
  return `const sanitizeTerminalText = ${sanitizeTerminalText.toString()};`;
}
