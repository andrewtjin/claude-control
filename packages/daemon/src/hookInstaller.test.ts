import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installHooks,
  uninstallHooks,
  buildDaemonHookSpecs,
  type HookCommandSpec,
} from './hookInstaller.js';
import { DEFAULT_SECRET_HEADER } from './hookReceiver.js';

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('installHooks', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hook-installer-'));
    settingsPath = join(dir, 'settings.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const spec = (event: string, command = `cmd-${event}`): HookCommandSpec => ({ event, command });

  it('creates settings.json from scratch when none exists', async () => {
    await installHooks({ settingsPath, hooks: [spec('Stop')] });
    const settings = (await readJson(settingsPath)) as { hooks: Record<string, unknown> };
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'cmd-Stop' }] }]);
  });

  it('is idempotent: installing the same hooks twice does not duplicate entries', async () => {
    await installHooks({ settingsPath, hooks: [spec('Stop'), spec('Notification')] });
    await installHooks({ settingsPath, hooks: [spec('Stop'), spec('Notification')] });
    const settings = (await readJson(settingsPath)) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop?.[0]?.hooks).toHaveLength(1);
    expect(settings.hooks.Notification).toHaveLength(1);
    expect(settings.hooks.Notification?.[0]?.hooks).toHaveLength(1);
  });

  it('preserves unrelated top-level settings keys', async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({ theme: 'dark', permissions: { allow: ['Bash(ls)'] }, hooks: {} }, null, 2),
    );
    await installHooks({ settingsPath, hooks: [spec('Stop')] });
    const settings = (await readJson(settingsPath)) as Record<string, unknown>;
    expect(settings.theme).toBe('dark');
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
  });

  it("preserves another tool's existing hook entries for the same event", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: 'some-other-tool --notify' }] }],
          },
        },
        null,
        2,
      ),
    );
    await installHooks({ settingsPath, hooks: [spec('Stop', 'our-command')] });
    const settings = (await readJson(settingsPath)) as {
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    const allCommands = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
    expect(allCommands).toContain('some-other-tool --notify');
    expect(allCommands).toContain('our-command');
  });

  it('preserves entries under a different matcher, and adds ours under its own matcher', async () => {
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { matcher: 'Write', hooks: [{ type: 'command', command: 'lint-on-write' }] },
            ],
          },
        },
        null,
        2,
      ),
    );
    await installHooks({
      settingsPath,
      hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'our-cmd' }],
    });
    const settings = (await readJson(settingsPath)) as {
      hooks: { PreToolUse: { matcher?: string; hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    const write = settings.hooks.PreToolUse.find((g) => g.matcher === 'Write');
    const bash = settings.hooks.PreToolUse.find((g) => g.matcher === 'Bash');
    expect(write?.hooks[0]?.command).toBe('lint-on-write');
    expect(bash?.hooks[0]?.command).toBe('our-cmd');
  });

  it('self-heals a malformed "hooks" value instead of throwing', async () => {
    await writeFile(settingsPath, JSON.stringify({ hooks: 'not-an-object', other: true }, null, 2));
    await installHooks({ settingsPath, hooks: [spec('Stop')] });
    const settings = (await readJson(settingsPath)) as {
      hooks: Record<string, unknown>;
      other: boolean;
    };
    expect(settings.other).toBe(true);
    expect(Array.isArray(settings.hooks.Stop)).toBe(true);
  });

  it('self-heals a malformed per-event value (not an array) instead of throwing', async () => {
    await writeFile(settingsPath, JSON.stringify({ hooks: { Stop: 'garbage' } }, null, 2));
    await installHooks({ settingsPath, hooks: [spec('Stop')] });
    const settings = (await readJson(settingsPath)) as { hooks: { Stop: unknown[] } };
    expect(Array.isArray(settings.hooks.Stop)).toBe(true);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it('refuses to overwrite a settings.json that is not valid JSON', async () => {
    await writeFile(settingsPath, '{not valid json');
    await expect(installHooks({ settingsPath, hooks: [spec('Stop')] })).rejects.toThrow(
      /not valid JSON/,
    );
    // The original (corrupt) content is untouched — we never destructively overwrote it.
    expect(await readFile(settingsPath, 'utf8')).toBe('{not valid json');
  });

  // An earlier command generation embedded an OS-assigned per-run port, so exact-command
  // dedup alone appended one dead entry per restart. These pin the ownedCommandMarker prune
  // that closes that hole (and now migrates old generations to the current command shape).
  describe('ownedCommandMarker (stale-generation pruning)', () => {
    /** Mirrors production: the marker is the secret-header name baked into every command. */
    const MARKER = 'x-claude-control-secret';
    const ourCommand = (port: number) => `curl -H "${MARKER}: s3cr3t" http://127.0.0.1:${port}/`;
    const install = (port: number) =>
      installHooks({
        settingsPath,
        hooks: [
          { event: 'PermissionRequest', command: ourCommand(port) },
          { event: 'Stop', command: ourCommand(port) },
        ],
        ownedCommandMarker: MARKER,
      });
    const commandsFor = (settings: unknown, event: string): string[] => {
      const groups = (settings as { hooks: Record<string, { hooks: { command: string }[] }[]> })
        .hooks[event];
      return (groups ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    };

    it('a restart with a new port REPLACES the previous entry instead of appending', async () => {
      await install(1111);
      await install(2222);
      const settings = await readJson(settingsPath);
      for (const event of ['PermissionRequest', 'Stop']) {
        expect(commandsFor(settings, event)).toEqual([ourCommand(2222)]);
      }
    });

    it('migrates a previous-generation curl entry to the current forwarder command', async () => {
      // The exact previous production shape: port-embedding curl with the secret header.
      const legacy = `curl -s -X POST -H "content-type: application/json" -H "${MARKER}: s3cr3t" --data-binary @- http://127.0.0.1:53441/`;
      await writeFile(
        settingsPath,
        JSON.stringify(
          { hooks: { Stop: [{ hooks: [{ type: 'command', command: legacy }] }] } },
          null,
          2,
        ),
      );
      const specs = buildDaemonHookSpecs({
        secret: 's3cr3t',
        forwarderPath: 'C:\\data\\hook-forward.cjs',
      });
      await installHooks({ settingsPath, hooks: specs, ownedCommandMarker: MARKER });
      const settings = await readJson(settingsPath);
      const stopSpec = specs.find((s) => s.event === 'Stop');
      expect(commandsFor(settings, 'Stop')).toEqual([stopSpec?.command]);
    });

    it('stays idempotent when the port has NOT changed', async () => {
      await install(1111);
      await install(1111);
      const settings = await readJson(settingsPath);
      expect(commandsFor(settings, 'Stop')).toEqual([ourCommand(1111)]);
    });

    it('never prunes foreign entries — no marker means not ours', async () => {
      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            hooks: {
              Stop: [
                { hooks: [{ type: 'command', command: 'some-other-tool --notify' }] },
                // Our stale generation shares a group with nobody, pointing at a dead port.
                { hooks: [{ type: 'command', command: ourCommand(1111) }] },
              ],
            },
          },
          null,
          2,
        ),
      );
      await install(2222);
      const settings = await readJson(settingsPath);
      const commands = commandsFor(settings, 'Stop');
      expect(commands).toContain('some-other-tool --notify');
      expect(commands).toContain(ourCommand(2222));
      expect(commands).not.toContain(ourCommand(1111));
    });

    it('drops a group its pruning emptied, but preserves a group that was already empty', async () => {
      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            hooks: {
              Stop: [
                { matcher: 'Bash', hooks: [{ type: 'command', command: ourCommand(1111) }] },
                { matcher: 'Write', hooks: [] }, // someone else's pre-existing empty group
              ],
            },
          },
          null,
          2,
        ),
      );
      await install(2222);
      const settings = (await readJson(settingsPath)) as {
        hooks: { Stop: { matcher?: string; hooks: unknown[] }[] };
      };
      const matchers = settings.hooks.Stop.map((g) => g.matcher);
      expect(matchers).not.toContain('Bash'); // emptied by pruning → dropped
      expect(matchers).toContain('Write'); // already empty → preserved
      expect(commandsFor(settings, 'Stop')).toEqual([ourCommand(2222)]);
    });

    it('leaves events outside the current specs untouched even if they carry the marker', async () => {
      await writeFile(
        settingsPath,
        JSON.stringify(
          {
            hooks: { Notification: [{ hooks: [{ type: 'command', command: ourCommand(1111) }] }] },
          },
          null,
          2,
        ),
      );
      await install(2222); // installs PermissionRequest + Stop only
      const settings = await readJson(settingsPath);
      expect(commandsFor(settings, 'Notification')).toEqual([ourCommand(1111)]);
    });
  });

  it('installs multiple distinct events in one call', async () => {
    await installHooks({
      settingsPath,
      hooks: [spec('PermissionRequest'), spec('Stop'), spec('Notification')],
    });
    const settings = (await readJson(settingsPath)) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'Notification',
      'PermissionRequest',
      'Stop',
    ]);
  });

  it('installs all five default daemon hook events, including UserPromptSubmit', async () => {
    const specs = buildDaemonHookSpecs({
      secret: 's3cr3t',
      forwarderPath: 'C:\\data\\hook-forward.cjs',
    });
    await installHooks({ settingsPath, hooks: specs });
    const settings = (await readJson(settingsPath)) as { hooks: Record<string, unknown> };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'Notification',
      'PermissionRequest',
      'PostToolUse',
      'Stop',
      'UserPromptSubmit',
    ]);
  });

  it('replaces a stale owned entry (e.g. after a secret rotation) instead of accumulating it', async () => {
    // Two real daemon specs for the SAME forwarder but different secrets — simulates a hook
    // secret rotating between two daemon starts. No ownedCommandMarker passed: this proves
    // the marker-free path recognizes both generations as ours via the secret-header name.
    const forwarderPath = 'C:\\data\\hook-forward.cjs';
    const before = buildDaemonHookSpecs({ forwarderPath, secret: 'old-secret' });
    const after = buildDaemonHookSpecs({ forwarderPath, secret: 'new-secret' });
    await installHooks({ settingsPath, hooks: before });
    await installHooks({ settingsPath, hooks: after });

    const settings = (await readJson(settingsPath)) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    for (const event of [
      'PermissionRequest',
      'Stop',
      'Notification',
      'PostToolUse',
      'UserPromptSubmit',
    ]) {
      const commands = settings.hooks[event]?.[0]?.hooks.map((h) => h.command) ?? [];
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain('new-secret');
      expect(commands[0]).not.toContain('old-secret');
    }
  });

  it('never touches a foreign hook that happens to share an event with ours', async () => {
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'some-other-tool --notify' }] }] },
        },
        null,
        2,
      ),
    );
    const forwarderPath = 'C:\\data\\hook-forward.cjs';
    const before = buildDaemonHookSpecs({ forwarderPath, secret: 'old-secret' });
    const after = buildDaemonHookSpecs({ forwarderPath, secret: 'new-secret' });
    await installHooks({ settingsPath, hooks: before });
    await installHooks({ settingsPath, hooks: after });

    const settings = (await readJson(settingsPath)) as {
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    const commands = settings.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain('some-other-tool --notify');
    expect(commands.filter((c) => c.includes('new-secret'))).toHaveLength(1);
    expect(commands.some((c) => c.includes('old-secret'))).toBe(false);
  });
});

describe('uninstallHooks', () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hook-installer-uninstall-'));
    settingsPath = join(dir, 'settings.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes every installed daemon hook (all five events) and leaves foreign entries + other keys intact', async () => {
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          theme: 'dark',
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: 'some-other-tool --notify' }] }],
          },
        },
        null,
        2,
      ),
    );
    await installHooks({
      settingsPath,
      hooks: buildDaemonHookSpecs({
        forwarderPath: 'C:\\data\\hook-forward.cjs',
        secret: 's3cr3t',
      }),
    });
    await expect(uninstallHooks({ settingsPath })).resolves.toBe('removed');

    const settings = (await readJson(settingsPath)) as {
      theme: string;
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(settings.theme).toBe('dark');
    expect(settings.hooks.PermissionRequest ?? []).toEqual([]);
    expect(settings.hooks.Notification ?? []).toEqual([]);
    expect(settings.hooks.PostToolUse ?? []).toEqual([]);
    expect(settings.hooks.UserPromptSubmit ?? []).toEqual([]);
    const stopCommands = (settings.hooks.Stop ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    expect(stopCommands).toEqual(['some-other-tool --notify']);
  });

  it('is a no-op (no rewrite) when nothing of ours is installed', async () => {
    await writeFile(settingsPath, JSON.stringify({ hooks: {} }, null, 2), 'utf8');
    const before = await readFile(settingsPath, 'utf8');
    await expect(uninstallHooks({ settingsPath })).resolves.toBe('none');
    expect(await readFile(settingsPath, 'utf8')).toBe(before);
  });

  it('does nothing (and does not throw) when settings.json does not exist', async () => {
    await expect(uninstallHooks({ settingsPath })).resolves.toBe('none');
  });
});

describe('buildDaemonHookSpecs', () => {
  const base = { secret: 's3cr3t', forwarderPath: 'C:\\data dir\\hook-forward.cjs' };

  it('builds one spec per default hook event, running the forwarder with the secret header', () => {
    const specs = buildDaemonHookSpecs(base);
    expect(specs).toHaveLength(5);
    expect(specs.map((s) => s.event).sort()).toEqual([
      'Notification',
      'PermissionRequest',
      'PostToolUse',
      'Stop',
      'UserPromptSubmit',
    ]);
    for (const s of specs) {
      expect(s.command).toContain('"C:\\data dir\\hook-forward.cjs"');
      expect(s.command).toContain(`--secret-header "${DEFAULT_SECRET_HEADER}: s3cr3t"`);
    }
  });

  it('the UserPromptSubmit spec uses the same forwarder command shape as the others', () => {
    const specs = buildDaemonHookSpecs(base);
    const permissionRequest = specs.find((s) => s.event === 'PermissionRequest');
    const userPromptSubmit = specs.find((s) => s.event === 'UserPromptSubmit');
    expect(userPromptSubmit).toBeDefined();
    expect(userPromptSubmit?.command).toBe(permissionRequest?.command);
    expect(userPromptSubmit?.matcher).toBeUndefined();
  });

  it('carries no port — the forwarder discovers the current one at fire time, so the command survives restarts', () => {
    for (const s of buildDaemonHookSpecs(base)) {
      expect(s.command).not.toMatch(/127\.0\.0\.1|\bcurl\b|:\d{2,5}\//);
    }
  });

  it('runs under the daemon’s own node binary by default, quoted (paths may contain spaces)', () => {
    const specs = buildDaemonHookSpecs(base);
    for (const s of specs) {
      expect(s.command.startsWith(`"${process.execPath}" `)).toBe(true);
    }
    const custom = buildDaemonHookSpecs({ ...base, nodePath: 'D:\\other node\\node.exe' });
    for (const s of custom) {
      expect(s.command.startsWith('"D:\\other node\\node.exe" ')).toBe(true);
    }
  });

  it('the PostToolUse spec carries no matcher — the receiver filters, not the hook', () => {
    const specs = buildDaemonHookSpecs(base);
    const postToolUse = specs.find((s) => s.event === 'PostToolUse');
    expect(postToolUse).toBeDefined();
    expect(postToolUse?.matcher).toBeUndefined();
  });

  it('bakes DEFAULT_SECRET_HEADER into every command — the marker daemonRun prunes by', () => {
    const specs = buildDaemonHookSpecs(base);
    for (const s of specs) {
      expect(s.command).toContain(DEFAULT_SECRET_HEADER);
    }
  });

  it('honors custom event names', () => {
    const specs = buildDaemonHookSpecs({
      ...base,
      eventNames: {
        permissionRequest: 'CustomPerm',
        stop: 'CustomStop',
        notification: 'CustomNotif',
        postToolUse: 'CustomPost',
        userPromptSubmit: 'CustomPrompt',
      },
    });
    expect(specs.map((s) => s.event).sort()).toEqual([
      'CustomNotif',
      'CustomPerm',
      'CustomPost',
      'CustomPrompt',
      'CustomStop',
    ]);
  });
});
