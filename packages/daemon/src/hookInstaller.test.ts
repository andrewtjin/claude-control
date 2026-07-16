import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHooks, buildDaemonHookSpecs, type HookCommandSpec } from './hookInstaller.js';

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
});

describe('buildDaemonHookSpecs', () => {
  it('builds one spec per default hook event, posting to the loopback receiver with the secret header', () => {
    const specs = buildDaemonHookSpecs({ port: 4567, secret: 's3cr3t' });
    expect(specs).toHaveLength(3);
    expect(specs.map((s) => s.event).sort()).toEqual(['Notification', 'PermissionRequest', 'Stop']);
    for (const s of specs) {
      expect(s.command).toContain('127.0.0.1:4567');
      expect(s.command).toContain('s3cr3t');
    }
  });

  it('honors custom event names', () => {
    const specs = buildDaemonHookSpecs({
      port: 1,
      secret: 'x',
      eventNames: {
        permissionRequest: 'CustomPerm',
        stop: 'CustomStop',
        notification: 'CustomNotif',
      },
    });
    expect(specs.map((s) => s.event).sort()).toEqual(['CustomNotif', 'CustomPerm', 'CustomStop']);
  });
});
