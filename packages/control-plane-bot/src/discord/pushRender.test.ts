import { describe, it, expect } from 'vitest';
import type { Envelope } from '@claude-control/shared-protocol';
import { decodeButton } from './buttons.js';
import { renderPush, RELOGIN_COMMAND } from './pushRender.js';

/** Minimal well-formed envelope wrapper so each test states only the payload that matters. */
function env(type: Envelope['type'], payload: unknown): Envelope {
  return { v: 1, id: 'id-1', ts: 0, daemonId: 'daemon-1', type, payload } as Envelope;
}

describe('renderPush — permission.request', () => {
  it('attaches Approve/Deny buttons carrying the requestId', () => {
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

  it('keeps the buttons in every permission mode (the daemon holds the decision channel)', () => {
    // The card only exists while the daemon holds the hook response open, so a remote tap
    // always takes effect — accept-edits still prompts for shell commands.
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
      expect(push?.components?.[0]).toHaveLength(3);
      expect(push?.embeds?.[0]?.toJSON().title).toBe('Permission requested');
    }
  });

  it('keeps the buttons when the mode is absent', () => {
    const push = renderPush(
      env('permission.request', { requestId: 'r', sessionId: 's', tool: 'Bash', summary: 'x' }),
    );
    expect(push?.components?.[0]).toHaveLength(3);
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

  it('a tool_output notification renders a compact embed with a fenced preview', () => {
    const push = renderPush(
      env('hook.notification', {
        event: 'notification',
        sessionId: 's1',
        title: 'Output — netstat -ano',
        body: 'TCP 127.0.0.1:5433 LISTENING 41184',
        level: 'info',
        notificationType: 'tool_output',
      }),
    );
    expect(push?.content).toBeUndefined();
    const json = push?.embeds?.[0]?.toJSON();
    expect(json?.title).toBe('Output — netstat -ano');
    expect(json?.description).toBe('```\nTCP 127.0.0.1:5433 LISTENING 41184\n```');
    // The session prefix rides the footer so concurrent windows stay distinguishable.
    expect(json?.footer?.text).toBe('s1');
    // Fits the preview whole — nothing to expand, no attachment.
    expect(push?.files).toBeUndefined();
  });

  it('tool_output puts the working directory and session prefix in the footer', () => {
    const push = renderPush(
      env('hook.notification', {
        event: 'notification',
        sessionId: '3b35a35f-7f34-46ca-95a0-90258b142eb0',
        cwd: 'C:\\repos\\claude-control-wt-remote',
        title: 'Output — netstat -ano',
        body: 'TCP LISTENING',
        level: 'info',
        notificationType: 'tool_output',
      }),
    );
    // Folder basename + an 8-char session prefix: enough to tell windows apart at a glance.
    expect(push?.embeds?.[0]?.toJSON().footer?.text).toBe('claude-control-wt-remote · 3b35a35f');
  });

  it('tool_output derives the folder from POSIX paths too, ignoring a trailing slash', () => {
    const push = renderPush(
      env('hook.notification', {
        event: 'notification',
        sessionId: 'abcd1234-9999',
        cwd: '/home/andrew/proj/',
        title: 'Output — ls',
        body: 'files',
        level: 'info',
        notificationType: 'tool_output',
      }),
    );
    expect(push?.embeds?.[0]?.toJSON().footer?.text).toBe('proj · abcd1234');
  });

  it('tool_output with no session identity has no footer', () => {
    const push = renderPush(
      env('hook.notification', {
        event: 'notification',
        title: 'Output — x',
        body: 'y',
        level: 'info',
        notificationType: 'tool_output',
      }),
    );
    const json = push?.embeds?.[0]?.toJSON();
    expect(json?.description).toBe('```\ny\n```');
    expect(json?.footer ?? undefined).toBeUndefined();
  });

  it('tool_output past the preview keeps the card glanceable and attaches the full text', () => {
    const push = renderPush(
      env('hook.notification', {
        event: 'notification',
        title: 'Output — big',
        body: 'x'.repeat(5000),
        level: 'info',
        notificationType: 'tool_output',
      }),
    );
    const json = push?.embeds?.[0]?.toJSON();
    // The card is a fixed-height preview with a visible continuation mark…
    expect(json?.description?.length).toBeLessThan(500);
    expect(json?.description).toContain('…');
    expect(json?.description).toContain('full output attached (5000 chars)');
    // …and the COMPLETE raw output rides as the tap-to-expand file attachment.
    expect(push?.files).toEqual([{ filename: 'output.txt', text: 'x'.repeat(5000) }]);
  });

  it('tool_output clamps the preview by line count, not only by chars', () => {
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const push = renderPush(
      env('hook.notification', {
        event: 'notification',
        title: 'Output — lines',
        body,
        level: 'info',
        notificationType: 'tool_output',
      }),
    );
    const description = push?.embeds?.[0]?.toJSON().description ?? '';
    expect(description).toContain('line 5');
    expect(description).not.toContain('line 6');
    expect(description).toContain('…');
    expect(push?.files).toEqual([{ filename: 'output.txt', text: body }]);
  });

  it('tool_output defuses embedded ``` so output cannot terminate its preview fence', () => {
    const push = renderPush(
      env('hook.notification', {
        event: 'notification',
        title: 'Output — tricky',
        body: 'before\n```\nafter',
        level: 'info',
        notificationType: 'tool_output',
      }),
    );
    // Everything between the opening and closing fence must contain no raw ``` run.
    const description = push!.embeds![0]!.toJSON().description!;
    const interior = description.slice(
      description.indexOf('```\n') + 4,
      description.lastIndexOf('\n```'),
    );
    expect(interior).not.toContain('```');
    expect(interior).toContain('before');
    expect(interior).toContain('after');
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

describe('renderPush — daemon error envelopes are surfaced', () => {
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
