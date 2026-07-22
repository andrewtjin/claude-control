import { describe, it, expect, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mapSdkMessage, buildSdkQueryOptions, type ToolNameMap } from './agentSdkMapping.js';
import type { AgentSdkEvent, AgentSdkQueryOptions } from './managedSession.js';

/** Build a minimal object shaped like the SDK message the mapper actually reads. The real
 *  SDKMessage union is huge; we only construct the few fields mapSdkMessage touches and cast,
 *  which is exactly why the mapper is testable without a real SDK subprocess. */
function sdkMsg(shape: Record<string, unknown>): SDKMessage {
  return shape as unknown as SDKMessage;
}

function mapAll(msgs: SDKMessage[]): { events: AgentSdkEvent[]; toolNames: ToolNameMap } {
  const toolNames: ToolNameMap = new Map();
  const events: AgentSdkEvent[] = [];
  for (const m of msgs) events.push(...mapSdkMessage(m, toolNames));
  return { events, toolNames };
}

describe('mapSdkMessage', () => {
  it('maps a system init message to session_init with the session id', () => {
    const { events } = mapAll([sdkMsg({ type: 'system', subtype: 'init', session_id: 'sdk-1' })]);
    expect(events).toEqual([{ type: 'session_init', sessionId: 'sdk-1' }]);
  });

  it('ignores non-init system messages', () => {
    const { events } = mapAll([sdkMsg({ type: 'system', subtype: 'compact_boundary' })]);
    expect(events).toEqual([]);
  });

  it('maps assistant text and tool_use, recording the tool_use id->name for later', () => {
    const { events, toolNames } = mapAll([
      sdkMsg({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'working' },
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { cmd: 'ls' } },
          ],
        },
      }),
    ]);
    expect(events).toEqual([
      { type: 'assistant_text', text: 'working' },
      { type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } },
    ]);
    expect(toolNames.get('tu-1')).toBe('Bash');
  });

  it('names a tool_result by the real tool name via the id->name map (the fixed stand-in)', () => {
    const { events } = mapAll([
      sdkMsg({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }] },
      }),
      sdkMsg({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done', is_error: false }],
        },
      }),
    ]);
    // The tool_result event carries 'Bash', NOT the raw 'tu-1' id.
    expect(events).toContainEqual({ type: 'tool_result', name: 'Bash', ok: true, text: 'done' });
  });

  it('falls back to the tool_use_id when the name is unknown (result with no seen tool_use)', () => {
    const { events } = mapAll([
      sdkMsg({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'orphan-id', is_error: true }] },
      }),
    ]);
    expect(events).toEqual([{ type: 'tool_result', name: 'orphan-id', ok: false }]);
  });

  it('maps a success result to a passing turn_result and an error result to a failing one', () => {
    const success = mapAll([
      sdkMsg({ type: 'result', subtype: 'success', result: 'all good', is_error: false }),
    ]);
    expect(success.events).toEqual([{ type: 'turn_result', ok: true, summary: 'all good' }]);

    const failure = mapAll([
      sdkMsg({ type: 'result', subtype: 'error_max_turns', errors: ['boom'], is_error: true }),
    ]);
    expect(failure.events).toEqual([{ type: 'turn_result', ok: false, summary: 'boom' }]);
  });
});

describe('buildSdkQueryOptions', () => {
  it('threads resume and cwd through', () => {
    const opts: AgentSdkQueryOptions = { resumeSessionId: 'sdk-9', cwd: '/work' };
    expect(buildSdkQueryOptions(opts)).toEqual({ resume: 'sdk-9', cwd: '/work' });
  });

  it('passes a known permission mode and drops an unrecognized one', () => {
    expect(buildSdkQueryOptions({ permissionMode: 'default' })).toEqual({
      permissionMode: 'default',
    });
    // A tolerant wire string that is not a real mode is dropped, not forwarded to a subprocess
    // that would reject it.
    expect(buildSdkQueryOptions({ permissionMode: 'made-up-mode' })).toEqual({});
  });

  it('binds accountId to a config dir when a resolver is given (the legitimate mechanism)', () => {
    const onUnbound = vi.fn();
    const shape = buildSdkQueryOptions(
      { accountId: 'acct-1' },
      {
        configDirForAccount: (id) => `/cfg/${id}`,
        onUnboundAccountId: onUnbound,
        baseEnv: { PATH: '/bin', HOME: '/home' },
      },
    );
    expect(shape.env).toEqual({ PATH: '/bin', HOME: '/home', CLAUDE_CONFIG_DIR: '/cfg/acct-1' });
    // Bound, so the loud fall-through is NOT taken.
    expect(onUnbound).not.toHaveBeenCalled();
  });

  it('makes an unbound accountId LOUD (never silent) and sets no env', () => {
    const onUnbound = vi.fn();
    const shape = buildSdkQueryOptions(
      { accountId: 'acct-1' },
      { onUnboundAccountId: onUnbound, baseEnv: {} },
    );
    expect(shape.env).toBeUndefined();
    expect(onUnbound).toHaveBeenCalledWith('acct-1');
  });

  it('treats a resolver that returns undefined as unbound (loud, no env)', () => {
    const onUnbound = vi.fn();
    const shape = buildSdkQueryOptions(
      { accountId: 'acct-1' },
      { configDirForAccount: () => undefined, onUnboundAccountId: onUnbound },
    );
    expect(shape.env).toBeUndefined();
    expect(onUnbound).toHaveBeenCalledWith('acct-1');
  });

  it('does nothing account-related when no accountId is present', () => {
    const onUnbound = vi.fn();
    const shape = buildSdkQueryOptions({ cwd: '/w' }, { onUnboundAccountId: onUnbound });
    expect(shape).toEqual({ cwd: '/w' });
    expect(onUnbound).not.toHaveBeenCalled();
  });
});
