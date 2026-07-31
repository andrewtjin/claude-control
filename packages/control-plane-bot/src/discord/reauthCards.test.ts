// The reauth customId codecs. Both decoders must return null (not throw, not guess) for a
// foreign id, because the gateway relies on that to fall through to its other grammars.

import { describe, it, expect } from 'vitest';
import {
  decodeReauthModal,
  decodeReauthPasteButton,
  encodeReauthModal,
  encodeReauthPasteButton,
  REAUTH_CODE_MAX_LENGTH,
} from './reauthCards.js';
import { decodeButton } from './buttons.js';
import { decodeQuestionModal } from './questionCards.js';

const REQUEST_ID = 'a1b2c3d4-0000-4000-8000-abcdefabcdef';

describe('reauth paste button id', () => {
  it('round-trips the requestId', () => {
    expect(decodeReauthPasteButton(encodeReauthPasteButton(REQUEST_ID))).toBe(REQUEST_ID);
  });

  it('stays under Discord’s 100-char customId ceiling for a real (uuid) requestId', () => {
    expect(encodeReauthPasteButton(REQUEST_ID).length).toBeLessThanOrEqual(100);
  });

  it('returns null for a foreign or empty id', () => {
    expect(decodeReauthPasteButton('cc:switch:go:na:0:acct-1')).toBeNull();
    expect(decodeReauthPasteButton('ccreauth:paste:')).toBeNull();
    expect(decodeReauthPasteButton('')).toBeNull();
  });
});

describe('reauth modal id', () => {
  it('round-trips the requestId', () => {
    expect(decodeReauthModal(encodeReauthModal(REQUEST_ID))).toBe(REQUEST_ID);
  });

  it('returns null for a foreign or empty id', () => {
    expect(decodeReauthModal('cc:question:modal:req-1:0')).toBeNull();
    expect(decodeReauthModal('ccreauth:modal:')).toBeNull();
  });

  it('caps the pasted code client-side as well as on the wire', () => {
    // Defense in depth beside reauth.code's own `.max(512)` — neither bound is trusted alone.
    expect(REAUTH_CODE_MAX_LENGTH).toBeGreaterThan(0);
    expect(REAUTH_CODE_MAX_LENGTH).toBeLessThanOrEqual(512);
  });
});

describe('grammar isolation', () => {
  it('the reauth ids are claimed by NO other decoder, and vice versa', () => {
    const pasteId = encodeReauthPasteButton(REQUEST_ID);
    const modalId = encodeReauthModal(REQUEST_ID);
    // buttons.ts must not treat the paste button as a two-tap action (it opens a modal, which
    // resolveTap's outcomes cannot express).
    expect(decodeButton(pasteId)).toBeNull();
    expect(decodeQuestionModal(modalId)).toBeNull();
    // And the paste decoder must not swallow the question flow's modal.
    expect(decodeReauthModal('cc:question:modal:req-1:0')).toBeNull();
  });
});
