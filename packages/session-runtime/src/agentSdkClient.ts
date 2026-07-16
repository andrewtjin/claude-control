// The real `AgentSdkClient` — adapts `@anthropic-ai/claude-agent-sdk`'s `query()` onto the
// minimal domain interface managedSession.ts depends on.
//
// WET-GATED: this file is checked for type-shape plausibility against the SDK's published
// `.d.ts` (there is no lighter-weight or offline way to validate an interactive CLI
// subprocess protocol) but is not exercised by the unit test suite — doing so would mean
// actually spawning a Claude Code process and consuming API/plan quota. `managedSession.ts`
// carries the real, fully unit-tested state machine and is fake-client-tested exhaustively;
// this adapter's only job is the message-shape translation below.
//
// Known gap: the SDK's real `tool_result` blocks carry `tool_use_id`, not the tool's name.
// A faithful `name` would require correlating that id back to the `tool_use` block that
// requested it, which needs cross-message state this stateless mapper doesn't keep. Using
// the id as a stand-in `name` is a deliberate simplification — good enough for a milestone
// line ("Tool result: <id> ok"), not for anything that needs the real tool name.
//
// Known gap: `canUseTool` (the SDK's permission-prompt hook) is not wired here, so managed
// sessions never actually emit `permission_required` against a live SDK today — permission
// handling for managed sessions is deferred to a higher layer. The event and the state
// machine support for it exist and are unit-tested for when that wiring lands.

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Query as SdkQuery, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSdkClient, AgentSdkEvent } from './managedSession.js';

/** A content block, loosely typed. The real SDK's block union (text/tool_use/thinking/
 *  tool_result/…) is large and partly re-exported from `@anthropic-ai/sdk`; narrowing by
 *  hand on the couple of fields we actually read avoids taking on that whole surface. */
interface LooseBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

function asBlocks(content: unknown): LooseBlock[] {
  return Array.isArray(content) ? (content as LooseBlock[]) : [];
}

function mapAssistantMessage(content: unknown): AgentSdkEvent[] {
  const events: AgentSdkEvent[] = [];
  for (const block of asBlocks(content)) {
    if (block.type === 'text' && typeof block.text === 'string') {
      events.push({ type: 'assistant_text', text: block.text });
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      events.push({ type: 'tool_use', name: block.name, input: block.input });
    }
  }
  return events;
}

function mapUserMessage(content: unknown): AgentSdkEvent[] {
  const events: AgentSdkEvent[] = [];
  for (const block of asBlocks(content)) {
    if (block.type !== 'tool_result') continue;
    const name = typeof block.tool_use_id === 'string' ? block.tool_use_id : 'unknown';
    const ok = block.is_error !== true;
    events.push({
      type: 'tool_result',
      name,
      ok,
      ...(typeof block.content === 'string' ? { text: block.content } : {}),
    });
  }
  return events;
}

/** Translate one raw SDK message into zero or more of our own domain events. Every
 *  message type this package doesn't act on (compaction boundaries, hook progress, task
 *  notifications, …) maps to `[]` — managedSession only needs the handful of signals that
 *  drive its state machine or are worth a milestone line. */
function mapSdkMessage(msg: SDKMessage): AgentSdkEvent[] {
  switch (msg.type) {
    case 'system':
      return msg.subtype === 'init' ? [{ type: 'session_init', sessionId: msg.session_id }] : [];
    case 'assistant':
      return mapAssistantMessage(msg.message.content);
    case 'user':
      return mapUserMessage(msg.message.content);
    case 'result': {
      // SDKResultMessage is success | error; only the success variant carries `result` —
      // the error variant carries `errors: string[]` instead, so summary needs to branch.
      const summary = msg.subtype === 'success' ? msg.result : (msg.errors[0] ?? msg.subtype);
      return [{ type: 'turn_result', ok: !msg.is_error, summary }];
    }
    default:
      return [];
  }
}

async function* mapQuery(q: SdkQuery): AsyncGenerator<AgentSdkEvent> {
  for await (const msg of q) {
    for (const event of mapSdkMessage(msg)) yield event;
  }
}

/** Build a real `AgentSdkClient`. `interrupt()`/`end()` target whichever `query()` call is
 *  currently in flight — managedSession never has two turns running concurrently (see its
 *  `busy` guard), so "the current one" is unambiguous. */
export function createAgentSdkClient(): AgentSdkClient {
  let current: SdkQuery | undefined;

  return {
    query(prompt, opts) {
      const q = sdkQuery({
        prompt,
        options: {
          ...(opts.resumeSessionId !== undefined ? { resume: opts.resumeSessionId } : {}),
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        },
      });
      current = q;
      return {
        [Symbol.asyncIterator]() {
          return mapQuery(q);
        },
      };
    },
    async interrupt(): Promise<void> {
      if (current) await current.interrupt();
    },
    end(): Promise<void> {
      current?.close();
      return Promise.resolve();
    },
  };
}
