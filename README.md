# claude-control

**Stop losing sessions to usage limits.** If you hold several Claude Code
subscriptions, quota you don't spend before it resets is gone for good — and the
account you're sitting in is rarely the one that's about to expire.
`claude-control` runs that arithmetic for you: it spends the budget expiring
soonest, hops accounts the moment the active one runs low, and keeps your phone
link alive across the hop.

Each person runs a **local daemon** on their own machine that manages 3–5 of their
own accounts. A single **shared Discord bot** acts as a credential-free control
plane: it holds no tokens and routes every interaction strictly by Discord user. Your
credentials never leave your machine. The bot does relay the session content your phone
cards are built from — commands, tool output, and the prompts you send — so if you'd
rather no shared operator see that, self-host it (see `docs/SELF_HOST.md`).

## Quick start

### Bot setup

First, [add the cctl bot to your Discord server](https://discord.com/oauth2/authorize?client_id=1527387188772208790&permissions=395137108992&scope=bot+applications.commands) or [add it to just your account](https://discord.com/oauth2/authorize?client_id=1527387188772208790&integration_type=1&scope=applications.commands)
and DM it. Either way is where `/pair` runs and where approvals, questions, and usage
cards reach you.

- For non-bot setups, see [Local-only](#local-only-no-discord) below.

### Daemon setup

Next, run:

```
npm i -g @andrewtjin/cctl
cctl setup
```

That's it. `cctl setup` will walk you through accounts, hooks, Discord pairing, and
autostart. See `docs/SETUP.md` for the full walkthrough.

If `cctl` isn't found after install, your npm global bin directory isn't on `PATH`;
run `npm prefix -g` and add the printed path (or its `bin` subfolder) to `PATH`.

## What it does

- **Burns the expiring budget first.** A weekly limit is the only quota that truly
  evaporates — a 5-hour window resets and hands the same capacity straight back.
  So the optimizer ranks accounts by which weekly budget dies soonest, spends that
  one, and holds the others in reserve. One line tells you which account to use
  now, and why.
- **Switches before you hit the wall, not after.** When the active account's worst
  limit runs low, the daemon moves to the best eligible account on its own — one
  with real session headroom, not already low itself, and with a reset clock it can
  actually see. No prompt, no dropped session. Or switch from your phone with one
  tap.
- **The remote link survives the switch.** Changing accounts doesn't cost you the
  session or the phone connection.
- **Every limit in one view.** 5-hour, weekly, and per-model limits across all
  accounts at once, with the reset clocks that make them actionable.
- **Approve from anywhere.** Permission prompts and "done / waiting" notices reach
  your phone; approve or deny from Discord. Send live prompts or start a fresh
  session and watch milestones stream back.

## Local-only (no Discord)

Just want the daemon, with everything in your terminal? Skip the pairing step in
`cctl setup` (type `s`) and nothing else changes: `cctl usage` and `cctl timeline`
show every limit and which account to burn, `cctl switch` hops accounts manually,
and `cctl daemon run --auto-switch` gives you the same before-the-wall automatic
switching — no Discord anywhere. Pair later anytime with `cctl setup --reconfigure`.

## Platform

**Windows and Linux (including WSL2) today.** Vault encryption is per-platform: DPAPI
on Windows, an owner-only key file on Linux. The macOS Keychain path is written and
unit-tested but has never run on a Mac, so macOS is not a supported platform yet.
See `docs/PLATFORM.md` for the details and `cctl doctor` for a live report on your
machine.

## Docs

- `docs/SETUP.md` — full `cctl setup` walkthrough, every step and unhappy path.
- `docs/CLI.md` — complete command reference, plus building from source.
- `docs/ARCHITECTURE.md` — system shape, package boundaries, trust model.
- `docs/PLATFORM.md` — per-platform caveats (vault encryption, autostart) and the
  Node version floor.
- `docs/SELF_HOST.md` — run your own control-plane bot instead of the shared one.
- `docs/VERIFICATION.md` — what's unit-proven vs. what needs on-machine confirmation.

## License

MIT — see [LICENSE](./LICENSE).
