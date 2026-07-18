# claude-control

Switch between multiple Claude Code subscription accounts, see usage across all of
them at once, and drive your sessions from your phone — with the remote link
surviving account switches.

Each person runs a **local daemon** on their own machine that manages 3–5 of their
own accounts. A single **shared Discord bot** acts as a credential-free control
plane: it holds no tokens and never sees session content, routing every interaction
strictly by Discord user. Your credentials never leave your machine.

## Quick start

```
npm i -g claudecontrol
cctl setup
```

That's it — `cctl setup` walks you through accounts, hooks, Discord pairing, and
autostart. See `docs/SETUP.md` for the full walkthrough.

If `cctl` isn't found after install, your npm global bin directory isn't on `PATH`;
run `npm prefix -g` and add the printed path (or its `bin` subfolder) to `PATH`.

## What it does

- **Auto-switch.** At low remaining 5h usage, you'll switch sessions to maximize uptime. Or, switch on phone with one tap.
- **Remote sessions.** Send live prompts or start a new session, and
  watch milestones stream back.
- **Cross-account usage optimization.** One view of every account's 5-hour, weekly, and per-model
  limits, with optimal use calculations.
- **Approve from anywhere.** permission prompts and "done / waiting" notices reach
  your phone; approve or deny from Discord.

## Platform

**Windows-only today** (macOS is a planned next milestone). See `docs/PLATFORM.md`
for the details and `cctl doctor` for a live report on your machine.

## Docs

- `docs/SETUP.md` — full `cctl setup` walkthrough, every step and unhappy path.
- `docs/CLI.md` — complete command reference, plus building from source.
- `docs/ARCHITECTURE.md` — system shape, package boundaries, trust model.
- `docs/PLATFORM.md` — Windows-only caveats and the Node version floor.
- `docs/SELF_HOST.md` — run your own control-plane bot instead of the shared one.
- `docs/VERIFICATION.md` — what's unit-proven vs. what needs on-machine confirmation.

## License

MIT — see [LICENSE](./LICENSE).
