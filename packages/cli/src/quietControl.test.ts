// The running daemon's live quiet-mode control: the value it serves, what a change writes to
// config.json and to the settings report, and the refusals that keep a change honest.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuietControl, type QuietControlOptions } from './quietControl.js';
import {
  discordQuietRow,
  readDaemonConfigFile,
  readSettingsReport,
  type SettingsReport,
} from './settings.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A temp data dir with the startup report written, and control options pointing into it. */
async function setup(overrides: Partial<QuietControlOptions> = {}): Promise<QuietControlOptions> {
  const dir = await mkdtemp(join(tmpdir(), 'cctl-quiet-control-'));
  dirs.push(dir);
  const report: SettingsReport = {
    startedAtMs: 1,
    settings: [
      { name: 'daemon build', value: 'v0.0.0', source: 'default' },
      discordQuietRow(true, 'default'),
    ],
    quiet: true,
  };
  const reportPath = join(dir, 'daemon-settings.json');
  await writeFile(reportPath, JSON.stringify(report));
  return {
    quiet: true,
    shellEnv: {},
    configPath: join(dir, 'config.json'),
    report,
    reportPath,
    ...overrides,
  };
}

describe('createQuietControl', () => {
  it('serves the startup value until a change', async () => {
    expect(createQuietControl(await setup()).isQuiet()).toBe(true);
    expect(createQuietControl(await setup({ quiet: false })).isQuiet()).toBe(false);
  });

  it('applies a change live, saves it to config.json, and rewrites the report', async () => {
    const options = await setup();
    const control = createQuietControl(options);
    const result = await control.set(false);

    expect(result).toMatchObject({ ok: true, quiet: false, changed: true });
    expect(control.isQuiet()).toBe(false);
    // Saved the way `cctl settings set quiet off` saves it, so it survives the next start.
    expect((await readDaemonConfigFile(options.configPath))?.env).toEqual({
      CCTL_DISCORD_QUIET: 'off',
    });
    // The report the daemon re-sends, and the file `cctl settings` reads, both show it.
    const expectedRow = discordQuietRow(false, 'config');
    if (result.ok) {
      expect(result.report.quiet).toBe(false);
      expect(result.report.settings).toContainEqual(expectedRow);
      // Every other row is left exactly as it was.
      expect(result.report.settings[0]).toEqual(options.report.settings[0]);
    }
    const onDisk = await readSettingsReport(options.reportPath);
    expect(onDisk?.quiet).toBe(false);
    expect(onDisk?.settings).toContainEqual(expectedRow);
  });

  it('reports a repeat of the value in force as unchanged', async () => {
    const control = createQuietControl(await setup());
    expect(await control.set(true)).toMatchObject({ ok: true, quiet: true, changed: false });
  });

  it('forgets the saved value on unset, back to the default (on)', async () => {
    const options = await setup();
    const control = createQuietControl(options);
    await control.set(false);
    const result = await control.set(undefined);

    expect(result).toMatchObject({ ok: true, quiet: true, changed: true });
    expect(await readDaemonConfigFile(options.configPath)).toEqual({});
    if (result.ok) expect(result.report.settings).toContainEqual(discordQuietRow(true, 'default'));
  });

  it('refuses a change the environment would undo at the next start, naming the variable', async () => {
    const options = await setup({ shellEnv: { CCTL_DISCORD_QUIET: 'on' } });
    const control = createQuietControl(options);
    const result = await control.set(false);

    expect(result).toMatchObject({ ok: false, quiet: true, reason: 'env_pinned' });
    if (!result.ok) expect(result.message).toContain('CCTL_DISCORD_QUIET');
    expect(control.isQuiet()).toBe(true);
    // Nothing was written: no config file was created.
    expect(await readDaemonConfigFile(options.configPath)).toBeUndefined();
  });

  it('counts an unreadable environment value as pinning too — it still shadows the file', async () => {
    const control = createQuietControl(await setup({ shellEnv: { CCTL_DISCORD_QUIET: 'maybe' } }));
    expect(await control.set(false)).toMatchObject({ ok: false, reason: 'env_pinned' });
    // A blank one does not: it is an absent override, as everywhere else.
    const blank = createQuietControl(await setup({ shellEnv: { CCTL_DISCORD_QUIET: '  ' } }));
    expect(await blank.set(false)).toMatchObject({ ok: true, quiet: false });
  });

  it('refuses, changing nothing, when config.json cannot be written', async () => {
    const options = await setup();
    // A file the writer refuses to overwrite (not a JSON object), rather than destroying it.
    await writeFile(options.configPath, '[1, 2]');
    const control = createQuietControl(options);
    const result = await control.set(false);

    expect(result).toMatchObject({ ok: false, quiet: true, reason: 'persist_failed' });
    expect(control.isQuiet()).toBe(true);
    expect(await readFile(options.configPath, 'utf8')).toBe('[1, 2]');
  });

  it('keeps a change whose report file could not be rewritten, and says so', async () => {
    const errors: unknown[] = [];
    const options = await setup({
      reportPath: join(tmpdir(), 'cctl-quiet-missing-dir', 'nested', 'daemon-settings.json'),
      onReportWriteError: (err) => errors.push(err),
    });
    const control = createQuietControl(options);
    expect(await control.set(false)).toMatchObject({ ok: true, quiet: false });
    expect(control.isQuiet()).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('serializes changes that arrive together, so the last one asked is the one in force', async () => {
    const options = await setup();
    const control = createQuietControl(options);
    const [first, second] = await Promise.all([control.set(false), control.set(true)]);

    expect(first).toMatchObject({ ok: true, quiet: false, changed: true });
    expect(second).toMatchObject({ ok: true, quiet: true, changed: true });
    expect(control.isQuiet()).toBe(true);
    expect((await readDaemonConfigFile(options.configPath))?.env).toEqual({
      CCTL_DISCORD_QUIET: 'on',
    });
  });
});
