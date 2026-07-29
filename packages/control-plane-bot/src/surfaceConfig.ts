// The env→surface decision for startup: given the process environment, which chat surface(s)
// bin.ts should build, or the exact reason none can start. Pure and side-effect-free (no
// process.exit, no reading process.env directly) so the full token matrix — none, Discord-only,
// Slack-only, both, and each half-configured Slack pair — is unit-testable without spawning this
// package's binary.
//
// "Set" means non-empty after trimming, not merely present. deploy/.env.example ships every
// token line blank (e.g. `SLACK_BOT_TOKEN=`), and that is exactly what env_file mechanisms turn
// into an empty string, not an absent variable. Plain JS truthiness already treats '' as unset,
// but a whitespace-only value (a stray trailing space from a copy-paste) is truthy and would
// silently pass as "configured" — so this module decides "set" once, explicitly, rather than
// leaning on truthiness at each call site.

/** True when `value` is present and has non-whitespace content. The type predicate lets callers
 *  narrow `string | undefined` to `string` at the point of use instead of re-deriving a boolean
 *  and asserting past `exactOptionalPropertyTypes` afterwards. */
function isSet(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/** Which surface(s) to start, once the environment has passed validation. Both fields are
 *  optional because a deployment may run Discord alone, Slack alone, or both side by side (see
 *  bin.ts's module comment); `slack` is only ever present with both of its tokens together, since
 *  a lone half is rejected before this type is ever constructed. */
export interface SurfaceTokens {
  discordToken?: string;
  slack?: { botToken: string; appToken: string };
}

/** The environment does not describe a startable configuration. `error` is the exact,
 *  user-facing message bin.ts prints and exits with — it names the specific missing variable
 *  rather than a generic complaint, because a deployment with one half of the Slack pair typed
 *  in is one env-file edit away from working and deserves to be told which edit. */
export interface SurfaceError {
  error: string;
}

export type SurfaceResolution = SurfaceTokens | SurfaceError;

/** Decide which chat surface(s) `env` configures, or why none can start.
 *
 *  Order matters: the paired-token checks run before the "nothing configured" check so that a
 *  half-set Slack pair (a deployment actively trying to run Slack) is reported by name, rather
 *  than folded into the generic "no surface configured" message that also covers a deployment
 *  that set nothing at all. */
export function resolveSurfaces(env: NodeJS.ProcessEnv): SurfaceResolution {
  const discordToken = env.DISCORD_BOT_TOKEN;
  const slackBotToken = env.SLACK_BOT_TOKEN;
  const slackAppToken = env.SLACK_APP_TOKEN;

  // Slack needs BOTH halves of its pair: SLACK_BOT_TOKEN authenticates the Bot User, but
  // Socket Mode's connection is opened with SLACK_APP_TOKEN — one without the other is a
  // surface that looks configured but can never actually deliver, so fail fast and name the
  // half that's missing rather than let it fail obscurely once Slack starts.
  if (isSet(slackBotToken) && !isSet(slackAppToken)) {
    return {
      error: 'SLACK_APP_TOKEN is not set. SLACK_BOT_TOKEN requires SLACK_APP_TOKEN (xapp-…) too.',
    };
  }
  if (isSet(slackAppToken) && !isSet(slackBotToken)) {
    return {
      error: 'SLACK_BOT_TOKEN is not set. SLACK_APP_TOKEN requires SLACK_BOT_TOKEN (xoxb-…) too.',
    };
  }
  if (!isSet(discordToken) && !(isSet(slackBotToken) && isSet(slackAppToken))) {
    return {
      error:
        'No chat surface is configured. Set DISCORD_BOT_TOKEN, or both SLACK_BOT_TOKEN and SLACK_APP_TOKEN.',
    };
  }

  const surfaces: SurfaceTokens = {};
  if (isSet(discordToken)) surfaces.discordToken = discordToken;
  if (isSet(slackBotToken) && isSet(slackAppToken)) {
    surfaces.slack = { botToken: slackBotToken, appToken: slackAppToken };
  }
  return surfaces;
}
