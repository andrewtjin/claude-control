import { describe, it, expect } from 'vitest';
import type { Envelope } from '@claude-control/shared-protocol';
import { decodeButton } from './buttons.js';
import { renderPush, RELOGIN_COMMAND } from './pushRender.js';

/** Minimal well-formed envelope wrapper so each test states only the payload that matters. */
function env(type: Envelope['type'], payload: unknown): Envelope {
  return { v: 1, id: 'id-1', ts: 0, daemonId: 'daemon-1', type, payload } as Envelope;
}

describe('renderPush — permission.request is mode-aware', () => {
  it('attaches Approve/Deny buttons ONLY in default mode', () => {
    const push = renderPush(
      env('permission.request', {
        requestId: 'req-1',
        sessionId: 's1',
        tool: 'Bash',
        summary: 'run rm -rf',
        permissionMode: 'default',
      }),
    );
    expect(push?.components?.[0]).toHaveLength(3);
    // The buttons carry this exact requestId, so a tap resolves to the right pending request.
    expect(decodeButton(push!.components![0]![0]!.customId)).toMatchObject({
      action: 'approve',
      id: 'req-1',
    });
    expect(push?.embeds?.[0]?.toJSON().title).toBe('Permission requested');
  });

  it('renders a button-less informational card for any non-default mode', () => {
    for (const mode of ['acceptEdits', 'plan', 'bypassPermissions', 'future-mode']) {
      const push = renderPush(
        env('permission.request', {
          requestId: 'r',
          sessionId: 's',
          tool: 'Bash',
          summary: 'x',
          permissionMode: mode,
        }),
      );
      expect(push?.components).toBeUndefined();
      expect(push?.embeds?.[0]?.toJSON().title).toBe('Permission (auto-handled)');
    }
  });

  it('treats an absent mode as non-actionable (fail-safe)', () => {
    const push = renderPush(
      env('permission.request', { requestId: 'r', sessionId: 's', tool: 'Bash', summary: 'x' }),
    );
    expect(push?.components).toBeUndefined();
  });
});

describe('renderPush — lifecycle notification cards', () => {
  it('a Stop event renders a done card carrying last_assistant_message', () => {
    const push = renderPush(
      env('hook.notification', {
        event: 'stop',
        sessionId: 's1',
        title: 'Done',
        body: 'ignored when a final message exists',
        level: 'info',
        lastAssistantMessage: 'All 42 tests pass.',
      }),
    );
    const json = push?.embeds?.[0]?.toJSON();
    expect(json?.title).toContain('✅');
    expect(json?.description).toBe('All 42 tests pass.');
  });

  it('an idle_prompt notification renders a waiting card', () => {
    const push = renderPush(
      env('hook.notification', {
        event: 'notification',
        title: 'Waiting',
        body: 'Claude needs your input',
        level: 'info',
        notificationType: 'idle_prompt',
      }),
    );
    const json = push?.embeds?.[0]?.toJSON();
    expect(json?.title).toContain('🔔');
    expect(json?.color).toBe(0x3498db);
  });

  it('a quarantine notification renders a card that prints the exact host re-login command', () => {
    const push = renderPush(
      env('hook.notification', {
        event: 'notification',
        title: 'Account down',
        body: 'Work can no longer refresh its token.',
        level: 'warn',
        notificationType: 'quarantine',
      }),
    );
    const json = push?.embeds?.[0]?.toJSON();
    expect(json?.title).toContain('🚫');
    const fix = json?.fields?.find((f) => f.name === 'Fix it on the host');
    expect(fix?.value).toContain(RELOGIN_COMMAND);
  });

  it('falls back to the generic content card for an unknown notificationType', () => {
    const push = renderPush(
      env('hook.notification', {
        event: 'notification',
        title: 'Heads up',
        body: 'something happened',
        level: 'info',
        notificationType: 'some_new_type',
      }),
    );
    expect(push?.embeds).toBeUndefined();
    expect(push?.content).toBe('**Heads up**\nsomething happened');
  });
});

describe('renderPush — routing of other envelopes', () => {
  it('switch.result renders a switch card', () => {
    const push = renderPush(
      env('switch.result', {
        requestId: 'r',
        ok: true,
        outcome: 'hot_applied',
        activeAccountId: 'a',
        message: 'switched',
      }),
    );
    expect(push?.embeds?.[0]?.toJSON().title).toBe('Switched');
  });

  it('session.output stdout is cache-only, but milestones DM', () => {
    expect(
      renderPush(
        env('session.output', {
          sessionId: 's',
          seq: 0,
          kind: 'stdout',
          text: 'noise',
          truncated: false,
        }),
      ),
    ).toBeUndefined();
    const milestone = renderPush(
      env('session.output', {
        sessionId: 's',
        seq: 1,
        kind: 'milestone',
        text: 'built',
        truncated: false,
      }),
    );
    expect(milestone?.content).toBe('built');
  });

  it('usage.snapshot is cache-only (no DM)', () => {
    expect(renderPush(env('usage.snapshot', { accounts: [] }))).toBeUndefined();
  });
});

describe('renderPush — daemon error envelopes are surfaced (finding 5)', () => {
  it('renders an error envelope as a visible DM carrying the code and message', () => {
    const push = renderPush(
      env('error', {
        code: 'unknown_session',
        message: "session.stop: no live session 'ghost' in this daemon",
        relatesTo: 'stop-frame-id',
      }),
    );
    expect(push?.content).toContain('unknown_session');
    expect(push?.content).toContain("no live session 'ghost'");
    expect(push?.embeds).toBeUndefined();
  });

  it('clamps an over-long error message to the content limit', () => {
    const push = renderPush(env('error', { code: 'boom', message: 'm'.repeat(5000) }));
    expect(push?.content).toBeDefined();
    expect(push!.content!.length).toBeLessThanOrEqual(2000);
    expect(push?.content).toContain('chars truncated');
  });

  it('still returns undefined for other cache-only control frames (pong)', () => {
    expect(renderPush(env('pong', {}))).toBeUndefined();
  });
});
