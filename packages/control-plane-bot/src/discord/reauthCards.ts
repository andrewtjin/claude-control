// customId grammar for the reauth paste flow: the "Paste code" button and the modal it opens.
//
// Deliberately NOT part of buttons.ts's grammar. That module is the two-tap CONFIRM machine for
// destructive actions (arm → confirm → execute, aged against a TTL); pasting a login code is
// neither destructive nor executable-on-tap — the tap's only job is to call `showModal()`, which
// must be the interaction's FIRST response and so can never route through `resolveTap`'s
// execute/confirm/restore outcomes. Same reason the question flow's "Other" modal has its own
// codec (questionCards.ts) rather than a ButtonAction.
//
// Both ids carry only the requestId the daemon minted the link under: it is the correlation key
// for the pending flow (which verifier, which account), and it is not a secret — the code the
// user pastes is worthless without the daemon-held verifier.

const BUTTON_PREFIX = 'ccreauth:paste:';
const MODAL_PREFIX = 'ccreauth:modal:';

/** The modal's single text input. Read back by the gateway on submit. */
export const REAUTH_MODAL_INPUT_ID = 'reauthCode';

/** Discord's own cap on a modal text input, applied client-side as defense in depth beside the
 *  wire schema's own bound (`reauth.code`'s `.max(512)`) — neither is trusted alone. */
export const REAUTH_CODE_MAX_LENGTH = 300;

export function encodeReauthPasteButton(requestId: string): string {
  return `${BUTTON_PREFIX}${requestId}`;
}

/** Decode a paste-button customId, or null for anything that isn't one (so the gateway can fall
 *  through to its other button grammars rather than guessing). */
export function decodeReauthPasteButton(customId: string): string | null {
  if (!customId.startsWith(BUTTON_PREFIX)) return null;
  return customId.slice(BUTTON_PREFIX.length) || null;
}

export function encodeReauthModal(requestId: string): string {
  return `${MODAL_PREFIX}${requestId}`;
}

/** Decode a reauth modal customId, or null — same fall-through contract as the button. */
export function decodeReauthModal(customId: string): string | null {
  if (!customId.startsWith(MODAL_PREFIX)) return null;
  return customId.slice(MODAL_PREFIX.length) || null;
}
