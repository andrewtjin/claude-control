import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Paths } from '@claude-control/switch-engine';
import type { SettingRow } from '@claude-control/shared-protocol';
import { PLAIN_PALETTE, type Palette } from './ansi.js';
import {
  DEFAULT_RELAY_URL,
  daemonSettingsPath,
  envFlag,
  envNumber,
  readSettingsReport,
  renderSettings,
  reportSaysGreedyActive,
  resolveCliSettings,
  resolveDaemonConfig,
  writeSettingsReport,
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
});

describe('resolveDaemonConfig', () => {
  it('is all defaults with no flags and no env', () => {
    const { values, rows } = resolveDaemonConfig({});
    expect(values).toEqual({
      relayUrl: DEFAULT_RELAY_URL,
      autoSwitch: false,
      greedy: false,
      triggerPercent: undefined,
      minSessionHeadroomPct: undefined,
      cooldownMs: undefined,
      waitingCards: false,
    });
    for (const r of rows) expect(r.source).toBe('default');
    expect(row(rows, 'auto-switch').value).toBe('off');
    expect(row(rows, 'greedy burn-back').value).toBe('off');
    expect(row(rows, 'switch trigger').value).toBe('94% used');
    expect(row(rows, 'min session headroom').value).toBe('25% left');
    expect(row(rows, 'auto-switch cooldown').value).toBe('10m');
    expect(row(rows, 'waiting cards').value).toBe('off');
    expect(row(rows, 'relay url').value).toBe(DEFAULT_RELAY_URL);
    expect(row(rows, 'daemon log level').value).toBe('info');
  });

  it('enables waiting cards (the "Claude is waiting…" nag forwarding) only via env opt-in', () => {
    const { values, rows } = resolveDaemonConfig({ CCTL_WAITING_CARDS: '1' });
    expect(values.waitingCards).toBe(true);
    expect(row(rows, 'waiting cards')).toMatchObject({ value: 'on', source: 'env' });
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

  it('labels env-enabled greedy as inactive when auto-switch is off', () => {
    const { values, rows } = resolveDaemonConfig({ CCTL_AUTOSWITCH_GREEDY: '1' });
    expect(values.greedy).toBe(true);
    expect(row(rows, 'greedy burn-back')).toMatchObject({
      value: 'on (inactive: needs --auto-switch)',
      source: 'env',
    });
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
    expect(reportSaysGreedyActive(report('off', 'on (inactive: needs --auto-switch)'))).toBe(false);
    expect(reportSaysGreedyActive(undefined)).toBe(false);
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
