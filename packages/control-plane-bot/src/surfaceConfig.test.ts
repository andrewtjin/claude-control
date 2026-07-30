import { describe, it, expect } from 'vitest';
import { resolveSurfaces } from './surfaceConfig.js';

/** Build a minimal env fixture with only the three vars resolveSurfaces reads. Omitted keys are
 *  the "absent" case; every present key here is deliberately typed `string`, so the "empty
 *  string" and "whitespace-only" variants below are the fixture author's explicit choice, not an
 *  accident of `undefined`. */
function env(vars: {
  DISCORD_BOT_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_APP_TOKEN?: string;
}): NodeJS.ProcessEnv {
  return vars;
}

const APP_MISSING =
  'SLACK_APP_TOKEN is not set. SLACK_BOT_TOKEN requires SLACK_APP_TOKEN (xapp-…) too.';
const BOT_MISSING =
  'SLACK_BOT_TOKEN is not set. SLACK_APP_TOKEN requires SLACK_BOT_TOKEN (xoxb-…) too.';
const NONE_CONFIGURED =
  'No chat surface is configured. Set DISCORD_BOT_TOKEN, or both SLACK_BOT_TOKEN and SLACK_APP_TOKEN.';

describe('resolveSurfaces: none configured', () => {
  it('errors when every var is absent', () => {
    expect(resolveSurfaces(env({}))).toEqual({ error: NONE_CONFIGURED });
  });

  it('errors when every var is present but empty — the deploy/.env.example shape', () => {
    expect(
      resolveSurfaces(env({ DISCORD_BOT_TOKEN: '', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '' })),
    ).toEqual({ error: NONE_CONFIGURED });
  });

  it('errors when every var is whitespace-only', () => {
    expect(
      resolveSurfaces(
        env({ DISCORD_BOT_TOKEN: '   ', SLACK_BOT_TOKEN: '  ', SLACK_APP_TOKEN: '\t' }),
      ),
    ).toEqual({ error: NONE_CONFIGURED });
  });
});

describe('resolveSurfaces: discord-only', () => {
  it('resolves discordToken with no slack vars present', () => {
    expect(resolveSurfaces(env({ DISCORD_BOT_TOKEN: 'd-token' }))).toEqual({
      discordToken: 'd-token',
    });
  });

  it('resolves discordToken when the slack vars are present but empty', () => {
    expect(
      resolveSurfaces(
        env({ DISCORD_BOT_TOKEN: 'd-token', SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: '' }),
      ),
    ).toEqual({ discordToken: 'd-token' });
  });

  it('resolves discordToken when the slack vars are whitespace-only', () => {
    expect(
      resolveSurfaces(
        env({ DISCORD_BOT_TOKEN: 'd-token', SLACK_BOT_TOKEN: ' ', SLACK_APP_TOKEN: ' ' }),
      ),
    ).toEqual({ discordToken: 'd-token' });
  });
});

describe('resolveSurfaces: slack-only', () => {
  it('resolves the slack pair with no discord var present', () => {
    expect(resolveSurfaces(env({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1' }))).toEqual({
      slack: { botToken: 'xoxb-1', appToken: 'xapp-1' },
    });
  });

  it('resolves the slack pair when DISCORD_BOT_TOKEN is present but empty', () => {
    expect(
      resolveSurfaces(
        env({ DISCORD_BOT_TOKEN: '', SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1' }),
      ),
    ).toEqual({ slack: { botToken: 'xoxb-1', appToken: 'xapp-1' } });
  });

  it('resolves the slack pair when DISCORD_BOT_TOKEN is whitespace-only', () => {
    expect(
      resolveSurfaces(
        env({ DISCORD_BOT_TOKEN: '  ', SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1' }),
      ),
    ).toEqual({ slack: { botToken: 'xoxb-1', appToken: 'xapp-1' } });
  });
});

describe('resolveSurfaces: both surfaces', () => {
  it('resolves discordToken and the slack pair together', () => {
    expect(
      resolveSurfaces(
        env({ DISCORD_BOT_TOKEN: 'd-token', SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: 'xapp-1' }),
      ),
    ).toEqual({ discordToken: 'd-token', slack: { botToken: 'xoxb-1', appToken: 'xapp-1' } });
  });
});

describe('resolveSurfaces: bot-without-app', () => {
  it('errors naming SLACK_APP_TOKEN when SLACK_APP_TOKEN is absent', () => {
    expect(resolveSurfaces(env({ SLACK_BOT_TOKEN: 'xoxb-1' }))).toEqual({ error: APP_MISSING });
  });

  it('errors naming SLACK_APP_TOKEN when SLACK_APP_TOKEN is present but empty', () => {
    expect(resolveSurfaces(env({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: '' }))).toEqual({
      error: APP_MISSING,
    });
  });

  it('errors naming SLACK_APP_TOKEN when SLACK_APP_TOKEN is whitespace-only', () => {
    expect(resolveSurfaces(env({ SLACK_BOT_TOKEN: 'xoxb-1', SLACK_APP_TOKEN: '   ' }))).toEqual({
      error: APP_MISSING,
    });
  });
});

describe('resolveSurfaces: app-without-bot', () => {
  it('errors naming SLACK_BOT_TOKEN when SLACK_BOT_TOKEN is absent', () => {
    expect(resolveSurfaces(env({ SLACK_APP_TOKEN: 'xapp-1' }))).toEqual({ error: BOT_MISSING });
  });

  it('errors naming SLACK_BOT_TOKEN when SLACK_BOT_TOKEN is present but empty — the exact shape deploy/.env.example ships once SLACK_APP_TOKEN is filled in', () => {
    expect(resolveSurfaces(env({ SLACK_BOT_TOKEN: '', SLACK_APP_TOKEN: 'xapp-1' }))).toEqual({
      error: BOT_MISSING,
    });
  });

  it('errors naming SLACK_BOT_TOKEN when SLACK_BOT_TOKEN is whitespace-only', () => {
    expect(resolveSurfaces(env({ SLACK_BOT_TOKEN: '  ', SLACK_APP_TOKEN: 'xapp-1' }))).toEqual({
      error: BOT_MISSING,
    });
  });
});
