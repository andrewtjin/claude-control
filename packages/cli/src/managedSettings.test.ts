import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCctlManagedSettings,
  canWriteManagedDir,
  CCTL_CHANNEL_PLUGIN,
  CCTL_DROP_IN_FILENAME,
  cctlDropInPath,
  diffCctlDropIn,
  elevatedCopyScript,
  elevatedLaunchScript,
  managedDropInDir,
  managedSettingsDir,
  OFFICIAL_CHANNEL_PLUGINS,
  readCctlDropIn,
  removeCctlDropIn,
  serializeCctlManagedSettings,
  verifyManagedSettingsEffective,
  writeCctlDropIn,
  writeCctlDropInElevated,
} from './managedSettings.js';

let dir: string;
let target: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cctl-managed-test-'));
  target = join(dir, 'managed-settings.d', CCTL_DROP_IN_FILENAME);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('locations', () => {
  it('resolves the per-platform directory the CLI actually reads', () => {
    expect(managedSettingsDir('win32')).toBe('C:\\Program Files\\ClaudeCode');
    expect(managedSettingsDir('darwin')).toBe('/Library/Application Support/ClaudeCode');
    expect(managedSettingsDir('linux')).toBe('/etc/claude-code');
  });

  it('targets the drop-in directory, never the base file', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(managedDropInDir(platform)).toContain('managed-settings.d');
      expect(cctlDropInPath(platform)).toContain(CCTL_DROP_IN_FILENAME);
      expect(cctlDropInPath(platform).endsWith('managed-settings.json')).toBe(false);
    }
  });
});

describe('content', () => {
  it('restates the official plugins, because the list replaces rather than extends', () => {
    const settings = buildCctlManagedSettings();
    for (const official of OFFICIAL_CHANNEL_PLUGINS) {
      expect(settings.allowedChannelPlugins).toContainEqual(official);
    }
    expect(settings.allowedChannelPlugins).toContainEqual(CCTL_CHANNEL_PLUGIN);
    expect(settings.channelsEnabled).toBe(true);
  });
});

describe('diff', () => {
  it('reports a create when nothing is there', () => {
    const d = diffCctlDropIn({ present: false });
    expect(d.changed).toBe(true);
    expect(d.action).toBe('create');
    expect(d.addedPlugins).toHaveLength(OFFICIAL_CHANNEL_PLUGINS.length + 1);
    expect(d.removedPlugins).toEqual([]);
  });

  it('reports no change when the file already says exactly what we want', () => {
    const text = serializeCctlManagedSettings(buildCctlManagedSettings());
    const d = diffCctlDropIn({ present: true, text, parsed: JSON.parse(text) });
    expect(d.changed).toBe(false);
    expect(d.action).toBe('none');
  });

  it('surfaces a foreign plugin our write would remove', () => {
    const foreign = { marketplace: 'acme', plugin: 'internal-alerts' };
    const parsed = { channelsEnabled: true, allowedChannelPlugins: [foreign] };
    const d = diffCctlDropIn({ present: true, text: JSON.stringify(parsed), parsed });
    expect(d.changed).toBe(true);
    expect(d.action).toBe('update');
    expect(d.removedPlugins).toContainEqual(foreign);
  });

  it('flags an unparseable existing file rather than quietly overwriting it', async () => {
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{not json', 'utf8');
    const current = await readCctlDropIn(bad);
    expect(current.present).toBe(true);
    const d = diffCctlDropIn(current);
    expect(d.parseError).toBeDefined();
    expect(d.changed).toBe(true);
  });
});

describe('write', () => {
  it('creates the drop-in directory and writes canonical content', async () => {
    const result = await writeCctlDropIn({ path: target });
    expect(result.outcome).toBe('written');
    expect(await readFile(target, 'utf8')).toBe(
      serializeCctlManagedSettings(buildCctlManagedSettings()),
    );
  });

  it('is idempotent — a second run writes nothing', async () => {
    await writeCctlDropIn({ path: target });
    expect((await writeCctlDropIn({ path: target })).outcome).toBe('unchanged');
  });

  it('leaves no temp file behind', async () => {
    await writeCctlDropIn({ path: target });
    expect(await readdir(join(dir, 'managed-settings.d'))).toEqual([CCTL_DROP_IN_FILENAME]);
  });

  it('never touches the base file next to it', async () => {
    const base = join(dir, 'managed-settings.json');
    await writeFile(base, '{"permissions":{"defaultMode":"plan"}}', 'utf8');
    await writeCctlDropIn({ path: target });
    expect(await readFile(base, 'utf8')).toBe('{"permissions":{"defaultMode":"plan"}}');
  });
});

describe('remove', () => {
  it('removes our file and reports it', async () => {
    await writeCctlDropIn({ path: target });
    expect((await removeCctlDropIn({ path: target })).outcome).toBe('removed');
  });

  it('never claims a removal that did not happen', async () => {
    expect((await removeCctlDropIn({ path: target })).outcome).toBe('none');
  });
});

describe('canWriteManagedDir', () => {
  it('is true for a writable directory and cleans up after itself', async () => {
    expect(await canWriteManagedDir(dir)).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it('is false rather than throwing when the directory cannot exist', async () => {
    const file = join(dir, 'a-file');
    await writeFile(file, 'x', 'utf8');
    expect(await canWriteManagedDir(join(file, 'nested'))).toBe(false);
  });
});

describe('privileged write', () => {
  it('stages content in a file instead of putting it on a command line', async () => {
    const scripts: string[] = [];
    const result = await writeCctlDropInElevated({
      path: target,
      platform: 'win32',
      stageDir: dir,
      runPowerShell: (s) => {
        scripts.push(s);
        return 'cctl-elevated-ok';
      },
    });
    expect(result.outcome).toBe('written');
    const launch = scripts[0] ?? '';
    expect(launch).toContain('-Verb RunAs');
    expect(launch).not.toContain('allowedChannelPlugins');
    expect(await readFile(join(dir, CCTL_DROP_IN_FILENAME), 'utf8')).toContain(
      'allowedChannelPlugins',
    );
  });

  it('reports a dismissed prompt as declined, not as a failure', async () => {
    const result = await writeCctlDropInElevated({
      path: target,
      platform: 'win32',
      stageDir: dir,
      runPowerShell: () => {
        throw new Error('cctl-elevation-declined The operation was canceled by the user.');
      },
    });
    expect(result.outcome).toBe('declined');
    expect(result.error).toMatch(/canceled by the user/i);
  });

  it('hands back a command to run instead of escalating on non-Windows', async () => {
    const result = await writeCctlDropInElevated({
      path: target,
      platform: 'darwin',
      runPowerShell: () => {
        throw new Error('must not be called');
      },
    });
    expect(result.outcome).toBe('unsupported');
    expect(result.manualCommand).toContain('sudo');
  });

  it('skips the prompt entirely when the file is already correct', async () => {
    await writeCctlDropIn({ path: target });
    const result = await writeCctlDropInElevated({
      path: target,
      platform: 'win32',
      stageDir: dir,
      runPowerShell: () => {
        throw new Error('must not be called');
      },
    });
    expect(result.outcome).toBe('unchanged');
  });

  it('quotes the target path safely in the generated script', () => {
    const script = elevatedCopyScript("C:\\stage\\it's.json", 'C:\\Program Files\\x\\y.json');
    expect(script).toContain("'C:\\Program Files\\x\\y.json'");
    expect(script).toContain("it''s.json");
    expect(elevatedLaunchScript('inner')).toContain('-EncodedCommand');
  });
});

describe('verify', () => {
  it('reports not-effective when nothing is written', async () => {
    const status = await verifyManagedSettingsEffective({ path: target });
    expect(status.effective).toBe(false);
    expect(status.presentButStale).toBe(false);
  });

  it('reports effective after a write', async () => {
    await writeCctlDropIn({ path: target });
    expect((await verifyManagedSettingsEffective({ path: target })).effective).toBe(true);
  });

  it('distinguishes a hand-edited file that dropped our entry', async () => {
    await writeCctlDropIn({ path: target });
    await writeFile(target, JSON.stringify({ allowedChannelPlugins: [] }), 'utf8');
    const status = await verifyManagedSettingsEffective({ path: target });
    expect(status.effective).toBe(false);
    expect(status.presentButStale).toBe(true);
  });
});
