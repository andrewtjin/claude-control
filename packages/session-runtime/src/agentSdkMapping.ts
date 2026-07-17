// Pure translation between the real Agent SDK's shapes and this package's own domain
// vocabulary — the half of the SDK adapter that has NO subprocess side effects and can
// therefore be unit-tested exhaustively. Only the thin wiring that actually calls
// `query()` / hands the SDK a `canUseTool` callback stays WET-gated (see agentSdkClient.ts).
//
// Everything here imports the SDK ONLY as `import type` (erased at compile time), so pulling
// this module into a test never loads the SDK runtime or spawns a Claude Code process.

import type { PermissionMode, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSdkEvent, AgentSdkQueryOptions } from './managedSession.js';

// ---------------------------------------------------------------------------
// SDK message -> domain event
// ---------------------------------------------------------------------------

/** Correlates a `tool_use` block's id to the tool's real name, so a later `tool_result`
 *  (which the SDK keys only by `tool_use_id`) can be named for real instead of showing a
 *  raw id. Lives for one turn — the adapter creates a fresh map per `query()`. */
export type ToolNameMap = Map<string, string>;

/** A content block, loosely typed. The real SDK's block union (text/tool_use/thinking/
 *  tool_result/…) is large and partly re-exported from `@anthropic-ai/sdk`; narrowing by
 *  hand on the couple of fields we actually read avoids taking on that whole surface. */
interface LooseBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

function asBlocks(content: unknown): LooseBlock[] {
  return Array.isArray(content) ? (content as LooseBlock[]) : [];
}

/** Map an assistant message's blocks, and — crucially — REMEMBER each tool_use block's
 *  id→name so the matching tool_result can be named later. The remembering is the fix for
 *  the old stand-in that showed `tool_use_id` where the tool name belonged. */
function mapAssistantMessage(content: unknown, toolNames: ToolNameMap): AgentSdkEvent[] {
  const events: AgentSdkEvent[] = [];
  for (const block of asBlocks(content)) {
    if (block.type === 'text' && typeof block.text === 'string') {
      events.push({ type: 'assistant_text', text: block.text });
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      if (typeof block.id === 'string') toolNames.set(block.id, block.name);
      events.push({ type: 'tool_use', name: block.name, input: block.input });
    }
  }
  return events;
}

/** Map a user message's tool_result blocks, resolving the real tool name from the id→name
 *  map built while streaming the assistant messages of the same turn. Falls back to the id
 *  when the mapping is unknown (e.g. a result whose tool_use we never saw) so a name is
 *  always present — the pre-existing "name is really the id" behavior, but now only as the
 *  genuine last resort rather than the default. */
function mapUserMessage(content: unknown, toolNames: ToolNameMap): AgentSdkEvent[] {
  const events: AgentSdkEvent[] = [];
  for (const block of asBlocks(content)) {
    if (block.type !== 'tool_result') continue;
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
    const name = (id !== undefined ? toolNames.get(id) : undefined) ?? id ?? 'unknown';
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

/**
 * Translate one raw SDK message into zero or more domain events, threading `toolNames` so
 * tool_result naming works across messages. Every message type this package doesn't act on
 * (compaction boundaries, hook progress, task notifications, …) maps to `[]` — managedSession
 * only needs the handful of signals that drive its state machine or are worth a milestone.
 *
 * Note `permission_required` is NOT produced here: the SDK surfaces permission prompts through
 * the `canUseTool` callback, not the message stream, so the adapter injects those events
 * separately (see agentSdkClient.ts).
 */
export function mapSdkMessage(msg: SDKMessage, toolNames: ToolNameMap): AgentSdkEvent[] {
  switch (msg.type) {
    case 'system':
      return msg.subtype === 'init' ? [{ type: 'session_init', sessionId: msg.session_id }] : [];
    case 'assistant':
      return mapAssistantMessage(msg.message.content, toolNames);
    case 'user':
      return mapUserMessage(msg.message.content, toolNames);
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

// ---------------------------------------------------------------------------
// Domain query options -> SDK query options
// ---------------------------------------------------------------------------

/** The known Claude Code permission modes. Kept as a value set (not just a type) so an
 *  incoming tolerant string from the wire can be validated before being handed to the SDK —
 *  an unrecognized mode is dropped rather than passed through to a subprocess that would
 *  reject it. */
const KNOWN_PERMISSION_MODES: ReadonlySet<string> = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
]);

/** The subset of the SDK's `Options` this adapter sets. Returned as a plain object the
 *  WET-gated adapter spreads into the real `query()` options alongside its `canUseTool`
 *  wiring. `env` is present only when we bind a per-account config dir (see below). */
export interface SdkQueryOptionsShape {
  resume?: string;
  cwd?: string;
  permissionMode?: PermissionMode;
  env?: Record<string, string | undefined>;
}

/**
 * How `accountId` reaches the SDK — the answer to "the SDK silently drops accountId today".
 *
 * FINDING: the SDK's `query()` has NO account/credential selector. It spawns the Claude Code
 * CLI, which reads OAuth credentials per-request from `$CLAUDE_CONFIG_DIR/.credentials.json`
 * (default `~/.claude`). The only credential-affecting knobs on `Options` are `env` (which
 * REPLACES the subprocess environment wholesale), `pathToClaudeCodeExecutable`, and
 * API-key-helper options (`apiKeyHelper`/`awsCredentialExport`) meant for API-key/Bedrock
 * auth — none of which pick among multiple stored OAuth accounts.
 *
 * Consequently there are exactly two honest postures, and this dep object chooses between
 * them per call rather than letting `accountId` vanish silently:
 *  - `configDirForAccount` given → bind the account by pointing `env.CLAUDE_CONFIG_DIR` at
 *    that account's config dir. This is the one legitimate SDK mechanism for per-session
 *    account isolation.
 *  - otherwise → the project's default single-shared-`~/.claude` design (plan §4/WT-1): the
 *    switch engine has already ACTIVATED the intended account globally before spawn, so the
 *    session inherits it. `accountId` is then an attribution tag, not a selector — and the
 *    drop is made LOUD via `onUnboundAccountId` (never silent), so a daemon that forgot to
 *    activate first is observable.
 */
export interface BuildSdkQueryOptionsDeps {
  /** Resolve an accountId to the CLAUDE_CONFIG_DIR holding that account's credentials. Return
   *  undefined to fall through to the shared-config design. */
  configDirForAccount?: (accountId: string) => string | undefined;
  /** Invoked when an accountId is present but NOT bound to a config dir, so the fall-through
   *  is loud rather than silent. Defaults (in the adapter) to a `console.warn`. */
  onUnboundAccountId?: (accountId: string) => void;
  /** Base environment to extend when binding a config dir. Defaults (in the adapter) to
   *  `process.env`; injectable so this pure function can be tested without touching the real
   *  environment. The SDK REPLACES the subprocess env, so a real bind must start from
   *  process.env or the subprocess loses PATH/HOME/etc. */
  baseEnv?: Record<string, string | undefined>;
}

/**
 * Build the SDK query options from our domain options. Pure and side-effect-free EXCEPT for
 * the intentional `onUnboundAccountId` diagnostic callback — which is how "accountId was
 * dropped" is surfaced loudly instead of silently.
 */
export function buildSdkQueryOptions(
  opts: AgentSdkQueryOptions,
  deps: BuildSdkQueryOptionsDeps = {},
): SdkQueryOptionsShape {
  const shape: SdkQueryOptionsShape = {
    ...(opts.resumeSessionId !== undefined ? { resume: opts.resumeSessionId } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.permissionMode !== undefined && KNOWN_PERMISSION_MODES.has(opts.permissionMode)
      ? { permissionMode: opts.permissionMode as PermissionMode }
      : {}),
  };

  if (opts.accountId !== undefined) {
    const configDir = deps.configDirForAccount?.(opts.accountId);
    if (configDir !== undefined) {
      // Legitimate mechanism: bind THIS session to THIS account's credentials via config dir.
      const baseEnv = deps.baseEnv ?? process.env;
      shape.env = { ...baseEnv, CLAUDE_CONFIG_DIR: configDir };
    } else {
      // Shared-config design: the account was (or must have been) activated globally already.
      // Loud, never silent.
      deps.onUnboundAccountId?.(opts.accountId);
    }
  }

  return shape;
}
