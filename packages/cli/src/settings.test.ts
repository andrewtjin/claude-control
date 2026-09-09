import { describe, it, expect } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Paths } from '@claude-control/switch-engine';
import type { SettingRow } from '@claude-control/shared-protocol';
import { PLAIN_PALETTE, type Palette } from './ansi.js';
import {
  DAEMON_ENV_SETTINGS,
  DEFAULT_RELAY_URL,
  applyFileEnv,
  checkSettingValue,
  daemonConfigPath,
  daemonSettingsPath,
  envBool,
  envFlag,
  envNumber,
  findDaemonEnvSetting,
  forgetDaemonSetting,
  layerFileEnv,
  persistDaemonSetting,
  readDaemonConfigFile,
  readSettingsReport,
  renderSettings,
  reportSaysGreedyActive,
  resolveCliSettings,
  resolveDaemonConfig,
  writeSettingsReport,
  type DaemonEnvSetting,
} from './settings.js';

/** Look up a row by name, failing loudly when the surface loses a knob. */
function row(rows: SettingRow[], name: string): SettingRow {
  const found = rows.find((r) => r.name === name);
  expect(found, `expected a "${name}" row`).toBeDefined();
  return found as SettingRow;
}

describe('envNumber / envFlag', () => {
  it('parses non-negative numbers and rejects garbage', () => {
    expect(envNumber({ X: '90' }, 'X')).toBe(90);
    expect(envNumber({ X: '0' }, 'X')).toBe(0);
    expect(envNumber({ X: 'banana' }, 'X')).toBeUndefined();
    expect(envNumber({ X: '-5' }, 'X')).toBeUndefined();
    expect(envNumber({ X: '  ' }, 'X')).toBeUndefined();
    expect(envNumber({}, 'X')).toBeUndefined();
  });

  it('accepts the usual truthy spellings only', () => {
    for (const on of ['1', 'true', 'YES', 'On']) expect(envFlag({ X: on }, 'X')).toBe(true);
    for (const off of ['0', 'false', 'nope', '']) expect(envFlag({ X: off }, 'X')).toBe(false);
    expect(envFlag({}, 'X')).toBe(false);
  });

  it('envBool distinguishes explicit on, explicit off, and unset/garbage', () => {
    for (const on of ['1', 'true', 'YES', 'On']) expect(envBool({ X: on }, 'X')).toBe(true);
    for (const off of ['0', 'false', 'No', 'OFF']) expect(envBool({ X: off }, 'X')).toBe(false);
    // Unset and typos fall back to the caller's default — and read as such in the view.
    expect(envBool({}, 'X')).toBeUndefined();
    expect(envBool({ X: 'nope' }, 'X')).toBeUndefined();
    expect(envBool({ X: '  ' }, 'X')).toBeUndefined();
  });
});

describe('resolveDaemonConfig', () => {
  it('is all defaults with no flags and no env', () => {
    const { values, rows } = resolveDaemonConfig({});
    expect(values).toEqual({
      relayUrl: DEFAULT_RELAY_URL,
      autoSwitch: true,
      greedy: true,
      autoSwitchOnFableCap: true,
      triggerPercent: undefined,
      staleTriggerPercent: undefined,
      staleAfterMs: undefined,
      minSessionHeadroomPct: undefined,
      greedyResetMarginMs: undefined,
      cooldownMs: undefined,
      waitingCards: false,
      permissionHoldMs: undefined,
      commandOutputCards: true,
      fullToolOutput: false,
      identityCheck: true,
    });
    for (const r of rows) expect(r.source).toBe('default');
    expect(row(rows, 'auto-switch').value).toBe('on');
    expect(row(rows, 'greedy burn-back').value).toBe('on');
    expect(row(rows, 'switch trigger').value).toBe('94% used');
    expect(row(rows, 'stale switch trigger').value).toBe('85% used');
    expect(row(rows, 'stale snapshot age').value).toBe('15m');
    expect(row(rows, 'min session headroom').value).toBe('25% left');
    expect(row(rows, 'greedy reset margin').value).toBe('15m');
    expect(row(rows, 'auto-switch cooldown').value).toBe('10m');
    expect(row(rows, 'waiting cards').value).toBe('off');
    expect(row(rows, 'permission hold').value).toBe('570s');
    expect(row(rows, 'command output cards').value).toBe('on');
    expect(row(rows, 'identity check').value).toBe('on');
    expect(row(rows, 'full tool output').value).toBe('off');
    expect(row(rows, 'relay url').value).toBe(DEFAULT_RELAY_URL);
    expect(row(rows, 'daemon log level').value).toBe('info');
    expect(row(rows, 'daemon log format').value).toBe('auto');
    expect(row(rows, 'daemon log file').value).toBe('off');
  });

  it('reports the logging env overrides an operator has actually set', () => {
    const { rows } = resolveDaemonConfig({
      CCTL_LOG_FORMAT: 'json',
      CCTL_LOG_FILE: '/var/log/cctl.log',
    });
    expect(row(rows, 'daemon log format')).toMatchObject({ value: 'json', source: 'env' });
    expect(row(rows, 'daemon log file')).toMatchObject({
      value: '/var/log/cctl.log',
      source: 'env',
    });
  });

  it('reads the permission hold window from CCTL_PERMISSION_HOLD_MS', () => {
    const { values, rows } = resolveDaemonConfig({ CCTL_PERMISSION_HOLD_MS: '60000' });
    expect(values.permissionHoldMs).toBe(60_000);
    expect(row(rows, 'permission hold')).toMatchObject({ value: '60s', source: 'env' });
  });

  it('reads the greedy reset margin from CCTL_AUTOSWITCH_GREEDY_RESET_MARGIN_MS', () => {
    const { values, rows } = resolveDaemonConfig({
      CCTL_AUTOSWITCH_GREEDY_RESET_MARGIN_MS: '3600000',
    });
    expect(values.greedyResetMarginMs).toBe(3_600_000);
    expect(row(rows, 'greedy reset margin')).toMatchObject({ value: '1h', source: 'env' });
  });

  it('reads the stale-trigger knobs from their env vars', () => {
    const { values, rows } = resolveDaemonConfig({
      CCTL_AUTOSWITCH_STALE_TRIGGER_PCT: '80',
      CCTL_AUTOSWITCH_STALE_AFTER_MS: '600000',
    });
    expect(values.staleTriggerPercent).toBe(80);
    expect(values.staleAfterMs).toBe(600_000);
    expect(row(rows, 'stale switch trigger')).toMatchObject({ value: '80% used', source: 'env' });
    expect(row(rows, 'stale snapshot age')).toMatchObject({ value: '10m', source: 'env' });
  });

  it('shows the stale trigger CLAMPED to the fresh one, matching what the policy will run', () => {
    // Stale data can only tighten the bar; a stale threshold configured above the fresh
    // trigger is ignored by the policy, so the view must show the value that actually fires.
    const { rows } = resolveDaemonConfig({
      CCTL_AUTOSWITCH_TRIGGER_PCT: '75',
      CCTL_AUTOSWITCH_STALE_TRIGGER_PCT: '90',
    });
    expect(row(rows, 'stale switch trigger').value).toBe('75% used');
  });

  it('enables waiting cards (the "Claude is waiting…" nag forwarding) only via env opt-in', () => {
    const { values, rows } = resolveDaemonConfig({ CCTL_WAITING_CARDS: '1' });
    expect(values.waitingCards).toBe(true);
    expect(row(rows, 'waiting cards')).toMatchObject({ value: 'on', source: 'env' });
  });

  it('silences command output cards via CCTL_COMMAND_OUTPUT=off (a default-on knob)', () => {
    const { values, rows } = resolveDaemonConfig({ CCTL_COMMAND_OUTPUT: 'off' });
    expect(values.commandOutputCards).toBe(false);
    expect(row(rows, 'command output cards')).toMatchObject({ value: 'off', source: 'env' });
    // A typo'd value falls back to the on default — and the view says default, not env.
    const typo = resolveDaemonConfig({ CCTL_COMMAND_OUTPUT: 'nope' });
    expect(typo.values.commandOutputCards).toBe(true);
    expect(row(typo.rows, 'command output cards')).toMatchObject({
      value: 'on',
      source: 'default',
    });
  });

  it('disables the network identity check via CCTL_IDENTITY_CHECK=off (default stays on)', () => {
    const off = resolveDaemonConfig({ CCTL_IDENTITY_CHECK: 'off' });
    expect(off.values.identityCheck).toBe(false);
    expect(row(off.rows, 'identity check')).toMatchObject({ value: 'off', source: 'env' });
    // A typo is not an override — the safe default (on) stands, attributed as default.
    const typo = resolveDaemonConfig({ CCTL_IDENTITY_CHECK: 'nah' });
    expect(typo.values.identityCheck).toBe(true);
    expect(row(typo.rows, 'identity check')).toMatchObject({ value: 'on', source: 'default' });
  });

  it('enables full tool output via CCTL_TOOL_OUTPUT_FULL', () => {
    const { values, rows } = resolveDaemonConfig({ CCTL_TOOL_OUTPUT_FULL: '1' });
    expect(values.fullToolOutput).toBe(true);
    expect(row(rows, 'full tool output')).toMatchObject({ value: 'on', source: 'env' });
  });

  it('reflects env overrides in both values and rows, with source "env"', () => {
    const env = {
      CCTL_AUTOSWITCH_TRIGGER_PCT: '88',
      CCTL_AUTOSWITCH_COOLDOWN_MS: '300000',
      CCTL_RELAY_URL: 'ws://relay.example:9999',
      CCTL_LOG_LEVEL: 'debug',
    };
    const { values, rows } = resolveDaemonConfig(env);
    expect(values.triggerPercent).toBe(88);
    expect(values.cooldownMs).toBe(300_000);
    expect(values.relayUrl).toBe('ws://relay.example:9999');
    expect(row(rows, 'switch trigger')).toMatchObject({ value: '88% used', source: 'env' });
    expect(row(rows, 'auto-switch cooldown')).toMatchObject({ value: '5m', source: 'env' });
    expect(row(rows, 'relay url')).toMatchObject({
      value: 'ws://relay.example:9999',
      source: 'env',
    });
    expect(row(rows, 'daemon log level')).toMatchObject({ value: 'debug', source: 'env' });
  });

  it('reports an unparseable env override as the default it actually falls back to', () => {
    const { values, rows } = resolveDaemonConfig({ CCTL_AUTOSWITCH_TRIGGER_PCT: 'banana' });
    expect(values.triggerPercent).toBeUndefined();
    // The daemon would RUN with 94, so the view must say 94/default — not echo the typo.
    expect(row(rows, 'switch trigger')).toMatchObject({ value: '94% used', source: 'default' });
  });

  it('marks flag-driven settings with source "flag"', () => {
    const { values, rows } = resolveDaemonConfig(
      { CCTL_RELAY_URL: 'ws://env.example:1' },
      { autoSwitch: true, greedy: true, relay: 'ws://flag.example:2' },
    );
    expect(values.autoSwitch).toBe(true);
    expect(values.greedy).toBe(true);
    expect(row(rows, 'auto-switch')).toMatchObject({ value: 'on', source: 'flag' });
    expect(row(rows, 'greedy burn-back')).toMatchObject({ value: 'on', source: 'flag' });
    // --relay outranks the env url.
    expect(row(rows, 'relay url')).toMatchObject({ value: 'ws://flag.example:2', source: 'flag' });
  });

  it('labels a still-on greedy as inactive when auto-switch is opted out', () => {
    const { values, rows } = resolveDaemonConfig({}, { autoSwitch: false });
    expect(values.autoSwitch).toBe(false);
    expect(values.greedy).toBe(true);
    expect(row(rows, 'auto-switch')).toMatchObject({ value: 'off', source: 'flag' });
    expect(row(rows, 'greedy burn-back')).toMatchObject({
      value: 'on (inactive: auto-switch is off)',
      source: 'default',
    });
  });

  it('turns auto-switch and greedy off via env for a flag-less (installed) daemon', () => {
    const { values, rows } = resolveDaemonConfig({
      CCTL_AUTOSWITCH: '0',
      CCTL_AUTOSWITCH_GREEDY: 'off',
    });
    expect(values.autoSwitch).toBe(false);
    expect(values.greedy).toBe(false);
    expect(row(rows, 'auto-switch')).toMatchObject({ value: 'off', source: 'env' });
    expect(row(rows, 'greedy burn-back')).toMatchObject({ value: 'off', source: 'env' });
  });

  it('lets explicit flags outrank the env opt-out', () => {
    const { values, rows } = resolveDaemonConfig(
      { CCTL_AUTOSWITCH: '0', CCTL_AUTOSWITCH_GREEDY: '0' },
      { autoSwitch: true, greedy: true },
    );
    expect(values.autoSwitch).toBe(true);
    expect(values.greedy).toBe(true);
    expect(row(rows, 'auto-switch')).toMatchObject({ value: 'on', source: 'flag' });
    expect(row(rows, 'greedy burn-back')).toMatchObject({ value: 'on', source: 'flag' });
  });

  it('keeps low-water auto-switch on under --no-greedy alone', () => {
    const { values, rows } = resolveDaemonConfig({}, { greedy: false });
    expect(values.autoSwitch).toBe(true);
    expect(values.greedy).toBe(false);
    expect(row(rows, 'auto-switch')).toMatchObject({ value: 'on', source: 'default' });
    expect(row(rows, 'greedy burn-back')).toMatchObject({ value: 'off', source: 'flag' });
  });
});

describe('resolveCliSettings', () => {
  it('is all defaults in a clean TTY environment', () => {
    const rows = resolveCliSettings({}, true);
    for (const r of rows) expect(r.source).toBe('default');
    expect(row(rows, 'color').value).toBe('on');
    expect(row(rows, 'switch cadence').value).toBe('1m between switches');
    expect(row(rows, 'token refresh skew').value).toBe('5m');
    expect(row(rows, 'cli log level').value).toBe('warn');
    expect(row(rows, 'cli log format').value).toBe('auto');
    expect(row(rows, 'cli log file').value).toBe('off');
  });

  it('attributes color-off to NO_COLOR only when it is actually set', () => {
    expect(row(resolveCliSettings({ NO_COLOR: '1' }, false), 'color')).toMatchObject({
      value: 'off',
      source: 'env',
    });
    // Off because stdout is not a TTY — that's the default behavior, not an override.
    expect(row(resolveCliSettings({}, false), 'color')).toMatchObject({
      value: 'off',
      source: 'default',
    });
  });

  it('shows a zero cadence as off', () => {
    expect(
      row(resolveCliSettings({ CCTL_SWITCH_MIN_INTERVAL_MS: '0' }, true), 'switch cadence'),
    ).toMatchObject({ value: 'off', source: 'env' });
  });
});

describe('renderSettings', () => {
  const rows: SettingRow[] = [
    { name: 'auto-switch', value: 'off', source: 'default', detail: '--auto-switch' },
    { name: 'greedy', value: 'on', source: 'env', detail: 'CCTL_AUTOSWITCH_GREEDY' },
  ];

  it('renders aligned plain-text sections by default', () => {
    expect(renderSettings([{ title: 'daemon', rows }])).toBe(
      [
        'daemon',
        '  auto-switch  off  default  --auto-switch',
        '  greedy       on   env      CCTL_AUTOSWITCH_GREEDY',
      ].join('\n'),
    );
  });

  it('aligns columns ACROSS sections and separates them with a blank line', () => {
    const text = renderSettings([
      { title: 'a', rows: [rows[0] as SettingRow] },
      { title: 'b', rows: [rows[1] as SettingRow] },
    ]);
    expect(text).toBe(
      [
        'a',
        '  auto-switch  off  default  --auto-switch',
        '',
        'b',
        '  greedy       on   env      CCTL_AUTOSWITCH_GREEDY',
      ].join('\n'),
    );
  });

  it('paints titles, on/off values, and override sources through the injected palette', () => {
    const marker = (tag: string) => (t: string) => `<${tag}>${t}</${tag}>`;
    const palette: Palette = {
      ...PLAIN_PALETTE,
      bold: marker('b'),
      dim: marker('d'),
      green: marker('g'),
      cyan: marker('c'),
    };
    const text = renderSettings([{ title: 'daemon', rows }], palette);
    expect(text).toContain('<b>daemon</b>');
    expect(text).toContain('<g>on </g>'); // padded first, painted after
    expect(text).toContain('<d>off</d>');
    expect(text).toContain('<c>env    </c>');
    expect(text).toContain('<d>default</d>');
    expect(text).toContain('<d>CCTL_AUTOSWITCH_GREEDY</d>');
  });
});

describe('reportSaysGreedyActive', () => {
  const report = (autoSwitch: string, greedy: string) => ({
    startedAtMs: 0,
    settings: [
      { name: 'auto-switch', value: autoSwitch, source: 'flag' as const },
      { name: 'greedy burn-back', value: greedy, source: 'env' as const },
    ],
  });

  it('is true only when BOTH auto-switch and greedy resolved to exactly "on"', () => {
    expect(reportSaysGreedyActive(report('on', 'on'))).toBe(true);
    expect(reportSaysGreedyActive(report('off', 'on'))).toBe(false);
    expect(reportSaysGreedyActive(report('on', 'off'))).toBe(false);
    // Greedy set but inactive renders as a longer string — correctly not "on".
    expect(reportSaysGreedyActive(report('off', 'on (inactive: auto-switch is off)'))).toBe(false);
    expect(reportSaysGreedyActive(undefined)).toBe(false);
  });
});

describe('operator config file', () => {
  it('derives its path beside the vault, distinct from the settings report', () => {
    const paths = { vaultDir: join('data', 'vault') } as Paths;
    expect(daemonConfigPath(paths)).toBe(join('data', 'config.json'));
    expect(daemonConfigPath(paths)).not.toBe(daemonSettingsPath(paths));
  });

  it('reads a relay url and degrades to undefined on missing, corrupt, or non-object files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-config-'));
    try {
      const file = join(dir, 'config.json');
      expect(await readDaemonConfigFile(file)).toBeUndefined(); // never written

      await writeFile(file, JSON.stringify({ relayUrl: 'wss://relay.example.com' }), 'utf8');
      expect(await readDaemonConfigFile(file)).toEqual({ relayUrl: 'wss://relay.example.com' });

      await writeFile(file, '{not json', 'utf8');
      expect(await readDaemonConfigFile(file)).toBeUndefined(); // corrupt

      await writeFile(file, JSON.stringify(['nope']), 'utf8');
      expect(await readDaemonConfigFile(file)).toBeUndefined(); // array, not an object
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a blank, whitespace-only, or non-string relayUrl as unset rather than as a value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-config-'));
    try {
      const file = join(dir, 'config.json');

      for (const bad of ['', '   ', 42, null] as const) {
        await writeFile(file, JSON.stringify({ relayUrl: bad }), 'utf8');
        // An object with no usable override — NOT undefined, since the file itself parsed.
        expect(await readDaemonConfigFile(file)).toEqual({});
      }

      // Surrounding whitespace on a real value is trimmed, not preserved into a dial attempt.
      await writeFile(file, JSON.stringify({ relayUrl: '  wss://relay.example.com  ' }), 'utf8');
      expect(await readDaemonConfigFile(file)).toEqual({ relayUrl: 'wss://relay.example.com' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the published default relay', () => {
  // Guards the one constant a published build cannot take back: shipping a loopback or
  // plaintext default would leave every fresh install dialing nothing over an unencrypted
  // socket. Asserts the PROPERTIES that must hold, not the literal hostname, so changing
  // where the relay lives stays a one-line edit.
  it('is a secure, non-loopback websocket url', () => {
    expect(DEFAULT_RELAY_URL.startsWith('wss://')).toBe(true);
    expect(DEFAULT_RELAY_URL).not.toMatch(/127\.0\.0\.1|localhost|\[::1\]/);
  });
});

describe('relay url precedence', () => {
  const FILE = { relayUrl: 'wss://from-file.example.com' };

  it('falls back to the config file when neither flag nor env is set, with source "config"', () => {
    const config = resolveDaemonConfig({}, {}, FILE);
    expect(config.values.relayUrl).toBe(FILE.relayUrl);
    expect(row(config.rows, 'relay url').source).toBe('config');
  });

  it('lets env shadow the config file, and reports the source that actually won', () => {
    const config = resolveDaemonConfig({ CCTL_RELAY_URL: 'wss://from-env.example.com' }, {}, FILE);
    expect(config.values.relayUrl).toBe('wss://from-env.example.com');
    expect(row(config.rows, 'relay url').source).toBe('env');
  });

  // `CCTL_RELAY_URL=` left in a profile, or `--relay "$UNSET"` in a wrapper, must not win the
  // chain with an empty string and point the daemon at nothing.
  it('treats a blank override at any level as absent and falls through', () => {
    const blankEnv = resolveDaemonConfig({ CCTL_RELAY_URL: '' }, {}, FILE);
    expect(blankEnv.values.relayUrl).toBe(FILE.relayUrl);
    expect(row(blankEnv.rows, 'relay url').source).toBe('config');

    const blankFlag = resolveDaemonConfig({}, { relay: '   ' }, FILE);
    expect(blankFlag.values.relayUrl).toBe(FILE.relayUrl);
    expect(row(blankFlag.rows, 'relay url').source).toBe('config');

    const allBlank = resolveDaemonConfig({ CCTL_RELAY_URL: '  ' }, { relay: '' }, { relayUrl: '' });
    expect(allBlank.values.relayUrl).toBe(DEFAULT_RELAY_URL);
    expect(row(allBlank.rows, 'relay url').source).toBe('default');
  });

  it('trims incidental whitespace around a real override', () => {
    const config = resolveDaemonConfig({ CCTL_RELAY_URL: '  wss://padded.example.com\n' }, {}, {});
    expect(config.values.relayUrl).toBe('wss://padded.example.com');
    expect(row(config.rows, 'relay url').source).toBe('env');
  });

  it('lets a flag beat both env and the config file', () => {
    const config = resolveDaemonConfig(
      { CCTL_RELAY_URL: 'wss://from-env.example.com' },
      { relay: 'wss://from-flag.example.com' },
      FILE,
    );
    expect(config.values.relayUrl).toBe('wss://from-flag.example.com');
    expect(row(config.rows, 'relay url').source).toBe('flag');
  });

  it('still reaches the built-in default when no source supplies a relay', () => {
    const config = resolveDaemonConfig({}, {}, {});
    expect(config.values.relayUrl).toBe(DEFAULT_RELAY_URL);
    expect(row(config.rows, 'relay url').source).toBe('default');
  });

  it('omitting the config argument entirely behaves exactly like an empty one', () => {
    expect(resolveDaemonConfig({})).toEqual(resolveDaemonConfig({}, {}, {}));
  });
});

describe('settings report file', () => {
  it('derives its path beside the vault', () => {
    const paths = { vaultDir: join('data', 'vault') } as Paths;
    expect(daemonSettingsPath(paths)).toBe(join('data', 'daemon-settings.json'));
  });

  it('round-trips a report and degrades to undefined on missing or corrupt files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-settings-'));
    try {
      const file = join(dir, 'daemon-settings.json');
      expect(await readSettingsReport(file)).toBeUndefined(); // never written

      const report = {
        startedAtMs: 1_700_000_000_000,
        settings: [{ name: 'auto-switch', value: 'on', source: 'flag' as const }],
      };
      await writeSettingsReport(file, report);
      expect(await readSettingsReport(file)).toEqual(report);

      await writeFile(file, '{not json', 'utf8');
      expect(await readSettingsReport(file)).toBeUndefined(); // corrupt

      await writeFile(file, JSON.stringify({ settings: 'nope' }), 'utf8');
      expect(await readSettingsReport(file)).toBeUndefined(); // wrong shape
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Every CCTL_ name the daemon rows tell an operator about. */
function namesInDaemonRows(): Set<string> {
  const names = new Set<string>();
  for (const r of resolveDaemonConfig({}).rows) {
    for (const m of (r.detail ?? '').matchAll(/CCTL_[A-Z0-9_]+/g)) names.add(m[0]);
  }
  return names;
}

const setting = (name: string): DaemonEnvSetting => {
  const found = findDaemonEnvSetting(name);
  expect(found, `expected ${name} to be a settable daemon setting`).toBeDefined();
  return found as DaemonEnvSetting;
};

describe('the settable daemon settings', () => {
  // The list `cctl settings set` accepts and the list `cctl settings` shows must be the same
  // list, or an operator is told about a knob they cannot set (or can set one nothing shows).
  it('are exactly the names the daemon rows advertise', () => {
    expect(new Set(DAEMON_ENV_SETTINGS.map((s) => s.name))).toEqual(namesInDaemonRows());
  });

  it('resolve by name regardless of case, and refuse unknown names', () => {
    expect(findDaemonEnvSetting('cctl_autoswitch')?.name).toBe('CCTL_AUTOSWITCH');
    expect(findDaemonEnvSetting('  CCTL_LOG_LEVEL ')?.name).toBe('CCTL_LOG_LEVEL');
    expect(findDaemonEnvSetting('CCTL_NOPE')).toBeUndefined();
    // Shell-side knobs are read by one-shot commands from their own environment.
    expect(findDaemonEnvSetting('CCTL_SWITCH_MIN_INTERVAL_MS')).toBeUndefined();
  });

  it('resolve by their short alias, with dashes and underscores interchangeable', () => {
    expect(findDaemonEnvSetting('fable-cap')?.name).toBe('CCTL_AUTOSWITCH_ON_FABLE_CAP');
    expect(findDaemonEnvSetting('FABLE_CAP')?.name).toBe('CCTL_AUTOSWITCH_ON_FABLE_CAP');
    expect(findDaemonEnvSetting('cctl-autoswitch-on-fable-cap')?.name).toBe(
      'CCTL_AUTOSWITCH_ON_FABLE_CAP',
    );
    expect(findDaemonEnvSetting('trigger')?.name).toBe('CCTL_AUTOSWITCH_TRIGGER_PCT');
    expect(findDaemonEnvSetting('relay')?.name).toBe('CCTL_RELAY_URL');
    expect(findDaemonEnvSetting('Log-Level')?.name).toBe('CCTL_LOG_LEVEL');
  });

  // A ref must mean one setting: no alias may double as another's alias or as any env name,
  // and every alias must be the lower-case kebab the lookup normalizes to.
  it('give every setting one well-formed alias that collides with nothing', () => {
    const aliases = DAEMON_ENV_SETTINGS.map((s) => s.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const s of DAEMON_ENV_SETTINGS) {
      expect(s.alias).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(DAEMON_ENV_SETTINGS.filter((o) => o.name === s.alias.toUpperCase())).toHaveLength(0);
      expect(findDaemonEnvSetting(s.alias)).toBe(s);
      expect(findDaemonEnvSetting(s.name)).toBe(s);
    }
  });

  it('check values with the same parsers the daemon reads with', () => {
    const bool = setting('CCTL_AUTOSWITCH');
    for (const ok of ['off', '0', 'FALSE', 'no', 'on', '1', 'yes', ' true ']) {
      expect(checkSettingValue(bool, ok)).toEqual({ ok: true, value: ok.trim() });
    }
    expect(checkSettingValue(bool, 'maybe')).toMatchObject({ ok: false });
    expect(checkSettingValue(bool, '')).toMatchObject({ ok: false });

    const num = setting('CCTL_AUTOSWITCH_TRIGGER_PCT');
    expect(checkSettingValue(num, '90')).toEqual({ ok: true, value: '90' });
    expect(checkSettingValue(num, '0')).toEqual({ ok: true, value: '0' });
    expect(checkSettingValue(num, '-1')).toMatchObject({ ok: false });
    expect(checkSettingValue(num, 'ninety')).toMatchObject({ ok: false });

    const url = setting('CCTL_RELAY_URL');
    expect(checkSettingValue(url, 'wss://relay.example.com')).toEqual({
      ok: true,
      value: 'wss://relay.example.com',
    });
    expect(checkSettingValue(url, 'https://relay.example.com')).toMatchObject({ ok: false });
    expect(checkSettingValue(url, 'wss://')).toMatchObject({ ok: false });

    const level = setting('CCTL_LOG_LEVEL');
    expect(checkSettingValue(level, 'Debug')).toEqual({ ok: true, value: 'debug' });
    expect(checkSettingValue(level, 'verbose')).toMatchObject({ ok: false });

    const format = setting('CCTL_LOG_FORMAT');
    expect(checkSettingValue(format, 'JSON')).toEqual({ ok: true, value: 'json' });
    expect(checkSettingValue(format, 'yaml')).toMatchObject({ ok: false });

    const path = setting('CCTL_LOG_FILE');
    expect(checkSettingValue(path, ' /var/log/cctl.log ')).toEqual({
      ok: true,
      value: '/var/log/cctl.log',
    });
    expect(checkSettingValue(path, '   ')).toMatchObject({ ok: false });
  });
});

describe('config.json env block', () => {
  it('layers under the environment: a set (non-blank) env var wins, even a misspelled one', () => {
    const file = { CCTL_AUTOSWITCH: 'off', CCTL_LOG_LEVEL: 'debug' };
    expect(layerFileEnv({}, file)).toEqual(file);
    expect(layerFileEnv({ CCTL_AUTOSWITCH: 'on' }, file).CCTL_AUTOSWITCH).toBe('on');
    expect(layerFileEnv({ CCTL_AUTOSWITCH: 'maybe' }, file).CCTL_AUTOSWITCH).toBe('maybe');
    expect(layerFileEnv({ CCTL_AUTOSWITCH: '  ' }, file).CCTL_AUTOSWITCH).toBe('off');
    // The pure form leaves its input alone; the in-place form is what the daemon applies.
    const env: NodeJS.ProcessEnv = { OTHER: 'x' };
    layerFileEnv(env, file);
    expect(env).toEqual({ OTHER: 'x' });
    expect(applyFileEnv(env, file)).toBe(env);
    expect(env).toEqual({ OTHER: 'x', ...file });
  });

  it('is read one known entry at a time, dropping blank, non-string and unknown ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-config-'));
    try {
      const file = join(dir, 'config.json');
      await writeFile(
        file,
        JSON.stringify({
          relayUrl: 'wss://relay.example.com',
          env: {
            cctl_autoswitch: ' off ',
            CCTL_AUTOSWITCH_TRIGGER_PCT: 90,
            CCTL_LOG_LEVEL: '',
            CCTL_NOT_A_SETTING: 'x',
            CCTL_SWITCH_MIN_INTERVAL_MS: '0',
            'fable-cap': 'off',
          },
        }),
        'utf8',
      );
      expect(await readDaemonConfigFile(file)).toEqual({
        relayUrl: 'wss://relay.example.com',
        env: { CCTL_AUTOSWITCH: 'off', CCTL_AUTOSWITCH_ON_FABLE_CAP: 'off' },
      });

      // A block with nothing usable in it reads as no block, not as an empty one.
      await writeFile(file, JSON.stringify({ env: { CCTL_NOPE: '1' } }), 'utf8');
      expect(await readDaemonConfigFile(file)).toEqual({});
      await writeFile(file, JSON.stringify({ env: ['CCTL_AUTOSWITCH=0'] }), 'utf8');
      expect(await readDaemonConfigFile(file)).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('folds a hand-written CCTL_RELAY_URL entry into relayUrl instead of keeping two relays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-config-'));
    try {
      const file = join(dir, 'config.json');
      await writeFile(file, JSON.stringify({ env: { CCTL_RELAY_URL: 'wss://a.example' } }), 'utf8');
      expect(await readDaemonConfigFile(file)).toEqual({ relayUrl: 'wss://a.example' });
      // The field wins when both are present.
      await writeFile(
        file,
        JSON.stringify({
          relayUrl: 'wss://field.example',
          env: { CCTL_RELAY_URL: 'wss://env.example' },
        }),
        'utf8',
      );
      expect(await readDaemonConfigFile(file)).toEqual({ relayUrl: 'wss://field.example' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('feeds every daemon knob, attributed to "config", with the environment still on top', () => {
    const fileConfig = {
      env: {
        CCTL_AUTOSWITCH: 'off',
        CCTL_AUTOSWITCH_ON_FABLE_CAP: 'off',
        CCTL_AUTOSWITCH_TRIGGER_PCT: '80',
        CCTL_WAITING_CARDS: 'on',
        CCTL_LOG_LEVEL: 'debug',
      },
    };
    const fromFile = resolveDaemonConfig({}, {}, fileConfig);
    expect(fromFile.values.autoSwitch).toBe(false);
    expect(row(fromFile.rows, 'auto-switch').source).toBe('config');
    expect(fromFile.values.autoSwitchOnFableCap).toBe(false);
    expect(row(fromFile.rows, 'fable cap trigger')).toMatchObject({
      value: 'off',
      source: 'config',
    });
    expect(fromFile.values.triggerPercent).toBe(80);
    expect(row(fromFile.rows, 'switch trigger')).toMatchObject({
      value: '80% used',
      source: 'config',
    });
    expect(fromFile.values.waitingCards).toBe(true);
    expect(row(fromFile.rows, 'waiting cards').source).toBe('config');
    expect(row(fromFile.rows, 'daemon log level')).toMatchObject({
      value: 'debug',
      source: 'config',
    });

    // A real env var shadows the file and is reported as the winner...
    const shadowed = resolveDaemonConfig({ CCTL_AUTOSWITCH: 'on' }, {}, fileConfig);
    expect(shadowed.values.autoSwitch).toBe(true);
    expect(row(shadowed.rows, 'auto-switch').source).toBe('env');
    // ...even a misspelled one, which then falls to the DEFAULT rather than to the file: the
    // environment always wins, with no exceptions to learn.
    const garbled = resolveDaemonConfig({ CCTL_AUTOSWITCH: 'maybe' }, {}, fileConfig);
    expect(garbled.values.autoSwitch).toBe(true);
    expect(row(garbled.rows, 'auto-switch').source).toBe('default');
    // A blank env var is an absent one, so the file applies.
    const blank = resolveDaemonConfig({ CCTL_AUTOSWITCH: '' }, {}, fileConfig);
    expect(blank.values.autoSwitch).toBe(false);
    expect(row(blank.rows, 'auto-switch').source).toBe('config');
    // A flag outranks both.
    const flagged = resolveDaemonConfig(
      { CCTL_AUTOSWITCH: 'off' },
      { autoSwitch: true },
      fileConfig,
    );
    expect(flagged.values.autoSwitch).toBe(true);
    expect(row(flagged.rows, 'auto-switch').source).toBe('flag');
  });

  // The two default-off knobs are attributed by presence like every other row: an explicit
  // "off" is an override that happens to equal the default, and says where it came from.
  it('attributes an explicit off on the default-off knobs to the layer that set it', () => {
    const fromFile = resolveDaemonConfig({}, {}, { env: { CCTL_WAITING_CARDS: 'off' } });
    expect(row(fromFile.rows, 'waiting cards')).toMatchObject({ value: 'off', source: 'config' });
    const fromEnv = resolveDaemonConfig({ CCTL_TOOL_OUTPUT_FULL: 'off' });
    expect(row(fromEnv.rows, 'full tool output')).toMatchObject({ value: 'off', source: 'env' });
    const garbled = resolveDaemonConfig({ CCTL_WAITING_CARDS: 'nope' });
    expect(row(garbled.rows, 'waiting cards')).toMatchObject({ value: 'off', source: 'default' });
  });

  it('defaults the fable cap trigger to on, and honors the env opt-out', () => {
    const config = resolveDaemonConfig({});
    expect(config.values.autoSwitchOnFableCap).toBe(true);
    expect(row(config.rows, 'fable cap trigger')).toMatchObject({ value: 'on', source: 'default' });
    const off = resolveDaemonConfig({ CCTL_AUTOSWITCH_ON_FABLE_CAP: '0' });
    expect(off.values.autoSwitchOnFableCap).toBe(false);
    expect(row(off.rows, 'fable cap trigger')).toMatchObject({ value: 'off', source: 'env' });
  });
});

describe('persisting daemon settings', () => {
  const exists = (file: string) =>
    access(file).then(
      () => true,
      () => false,
    );

  it('writes the env block, keeps unknown keys, and removes cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-config-'));
    try {
      const file = join(dir, 'config.json');
      // A key this build does not know must survive every round trip untouched.
      await writeFile(file, JSON.stringify({ future: { keep: true } }), 'utf8');

      await persistDaemonSetting(file, setting('CCTL_AUTOSWITCH'), 'off');
      await persistDaemonSetting(file, setting('CCTL_AUTOSWITCH_TRIGGER_PCT'), '90');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        future: { keep: true },
        env: { CCTL_AUTOSWITCH: 'off', CCTL_AUTOSWITCH_TRIGGER_PCT: '90' },
      });
      // What the daemon will read back is exactly what was stored.
      expect((await readDaemonConfigFile(file))?.env).toEqual({
        CCTL_AUTOSWITCH: 'off',
        CCTL_AUTOSWITCH_TRIGGER_PCT: '90',
      });

      // The relay goes to its own field, and is forgotten from there.
      await persistDaemonSetting(file, setting('CCTL_RELAY_URL'), 'wss://relay.example.com');
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
        relayUrl: 'wss://relay.example.com',
      });
      expect(await forgetDaemonSetting(file, setting('CCTL_RELAY_URL'))).toBe(true);
      expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('relayUrl');

      expect(await forgetDaemonSetting(file, setting('CCTL_AUTOSWITCH'))).toBe(true);
      expect(await forgetDaemonSetting(file, setting('CCTL_AUTOSWITCH'))).toBe(false);
      expect(await forgetDaemonSetting(file, setting('CCTL_AUTOSWITCH_TRIGGER_PCT'))).toBe(true);
      // The emptied block is gone: the file is back to exactly what it was before the first set.
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ future: { keep: true } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The reader accepts an alias or another case as a key, so `unset` (and a `set` that would
  // otherwise sit beside it) must find those spellings too, or a hand-written entry stays in
  // force while the CLI reports it gone.
  it('removes and replaces hand-written spellings the reader would also accept', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-config-'));
    try {
      const file = join(dir, 'config.json');
      await writeFile(
        file,
        JSON.stringify({
          relayUrl: 'wss://field.example',
          env: { autoswitch: 'off', cctl_autoswitch: 'on', CCTL_RELAY_URL: 'wss://env.example' },
        }),
        'utf8',
      );
      await persistDaemonSetting(file, setting('CCTL_AUTOSWITCH'), 'off');
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
        env: { CCTL_AUTOSWITCH: 'off', CCTL_RELAY_URL: 'wss://env.example' },
      });
      expect(await forgetDaemonSetting(file, setting('CCTL_AUTOSWITCH'))).toBe(true);
      // The relay is forgotten from BOTH homes: the field and the env-block entry the reader
      // would otherwise fold back into it.
      expect(await forgetDaemonSetting(file, setting('CCTL_RELAY_URL'))).toBe(true);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({});
      expect((await readDaemonConfigFile(file))?.relayUrl).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates the file (and its directory) on the first set, never on a no-op unset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-config-'));
    try {
      const file = join(dir, 'nested', 'config.json');
      expect(await forgetDaemonSetting(file, setting('CCTL_AUTOSWITCH'))).toBe(false);
      expect(await exists(file)).toBe(false);
      await persistDaemonSetting(file, setting('CCTL_LOG_LEVEL'), 'debug');
      expect(await readDaemonConfigFile(file)).toEqual({ env: { CCTL_LOG_LEVEL: 'debug' } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite a file it cannot read as a JSON object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-config-'));
    try {
      const file = join(dir, 'config.json');
      await writeFile(file, '{not json', 'utf8');
      await expect(persistDaemonSetting(file, setting('CCTL_AUTOSWITCH'), 'off')).rejects.toThrow(
        /not valid JSON/,
      );
      expect(await readFile(file, 'utf8')).toBe('{not json');
      await writeFile(file, '[1]', 'utf8');
      await expect(persistDaemonSetting(file, setting('CCTL_AUTOSWITCH'), 'off')).rejects.toThrow(
        /JSON object/,
      );
      expect(await readFile(file, 'utf8')).toBe('[1]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
