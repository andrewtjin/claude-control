// The pure, testable core of AskUserQuestion handling: parsing the CLI's `tool_input.questions`
// into structured prompts, and composing a human's structured answers back into the CLI's
// `updatedInput.answers` map. Extracted from the live-boundary adapter (agentSdkClient.ts) for
// exactly the reason the permission gate and SDK-message mapper were: everything that can be
// tested without a real subprocess lives here, so the adapter is left as irreducible wiring.

import type { QuestionAnswer, QuestionOption, QuestionPrompt } from './types.js';

/** Attacker-adjacent narrowing helpers — `tool_input` is whatever the locally-running CLI sends,
 *  so every field is checked before use rather than trusted. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Parse one option, or `undefined` if it lacks a usable `label` (the only field that
 *  round-trips into an answer; a labelless option is unrenderable and unanswerable). */
function parseOption(raw: unknown): QuestionOption | undefined {
  if (!isRecord(raw)) return undefined;
  const label = str(raw.label);
  if (label === undefined || label === '') return undefined;
  const description = str(raw.description);
  return { label, ...(description !== undefined ? { description } : {}) };
}

/**
 * Parse `tool_input.questions` into structured prompts, DEFENSIVELY. Returns `undefined` — the
 * signal to fall back to the tool's non-remote behavior — when the shape is anything other than a
 * non-empty array of questions we can faithfully render: a missing/empty `questions` array, a
 * question with no text, or a question with no usable options. We refuse to emit a partial or
 * lossy request because a question the phone can't answer faithfully is worse than letting the
 * terminal handle it (the correct lapse), and because a malformed prompt would otherwise strand
 * the session on an unanswerable card until the hold expires.
 */
export function parseQuestions(toolInput: unknown): QuestionPrompt[] | undefined {
  if (!isRecord(toolInput) || !Array.isArray(toolInput.questions)) return undefined;
  if (toolInput.questions.length === 0) return undefined;
  const prompts: QuestionPrompt[] = [];
  for (const raw of toolInput.questions) {
    if (!isRecord(raw)) return undefined;
    const question = str(raw.question);
    if (question === undefined || question === '') return undefined;
    if (!Array.isArray(raw.options)) return undefined;
    const options: QuestionOption[] = [];
    for (const rawOption of raw.options) {
      const option = parseOption(rawOption);
      if (option === undefined) return undefined;
      options.push(option);
    }
    if (options.length === 0) return undefined;
    const header = str(raw.header);
    prompts.push({
      question,
      multiSelect: raw.multiSelect === true,
      options,
      ...(header !== undefined ? { header } : {}),
    });
  }
  return prompts;
}

/**
 * Compose structured answers into the CLI's `updatedInput.answers` map. The map is keyed by
 * question TEXT — exactly the key the CLI's AskUserQuestion result requires — and each value is
 * the plain string the CLI expects: a free-form `otherText` when present, otherwise the chosen
 * option labels joined with ", " (which collapses to the single chosen label for a non-multiSelect
 * question). `otherText` winning over `selected` mirrors the terminal picker, where "Other"
 * replaces a listed choice.
 */
export function composeAnswers(answers: QuestionAnswer[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const answer of answers) {
    map[answer.question] = answer.otherText ?? answer.selected.join(', ');
  }
  return map;
}
