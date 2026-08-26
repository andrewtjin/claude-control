# Platform support

**Windows and Linux (including WSL2) today.** The platform-dependent seams:

- **Credential vault encryption** is per-platform:
  - **Windows** uses DPAPI (via PowerShell `ProtectedData`, `CurrentUser` scope) — a
    stolen vault directory is useless on another machine or under another account.
  - **Linux and other POSIX platforms** use a machine-local key file
    (`~/.local/share/claude-control/vault.key`, owner-only `0600` in a `0700` dir,
    honoring `XDG_DATA_HOME`) with the vault blobs AES-256-GCM sealed in-process.
    Why not libsecret: a desktop keyring needs an unlocked D-Bus session, which WSL2,
    SSH sessions, servers, and autostarted daemons don't have — and a vault sealed
    via a keyring would become undecryptable the moment the daemon runs headless.
    Stated honestly, the key file defeats a copied vault directory but not an
    attacker who can read your whole home directory; that matches the platform's own
    baseline (the Claude CLI keeps its live credentials as plaintext in
    `~/.claude/.credentials.json` on Linux). Anything stronger is full-disk
    encryption's job.

  - **macOS** uses a random key held in the login Keychain, with the vault blobs
    AES-256-GCM sealed in-process — the same threat model as DPAPI. This code path
    ships today but is **not a supported platform**: see "macOS" below for exactly
    what that means.

  `cctl doctor` runs a real protect/unprotect round-trip through this platform's
  protector and reports the result outright, instead of failing silently later.

- **Autostart** registers a logon **Scheduled Task** (`cctl daemon install`), because
  the DPAPI vault is `CurrentUser`-scoped: the daemon must run as the logged-in user,
  which makes a Windows service structurally wrong regardless of convenience — a
  service runs as SYSTEM/a service account by default and could never decrypt the
  vault.
- **Observed sessions** (watching a live terminal you started yourself) target ConPTY,
  the Windows pseudo-console. This is an optional dependency (`node-pty`) — its
  absence degrades gracefully with a clear message rather than crashing `cctl run`.

Everything else — the daemon, the bot, the CLI, usage polling, remote/managed
sessions — is portable Node ≥ 22.5.

## Node version floor

`cctl` needs **Node ≥ 22.13.0**, not the `>=22.5.0` in `package.json`'s `engines`
field. `node:sqlite` (the daemon's storage) exists from 22.5.0 but stays behind the
`--experimental-sqlite` flag until 22.13.0 (23.4.0 on the 23.x line) — and `cctl` runs
as a bare command or a Scheduled Task action, so it has no way to pass that flag. On
22.5–22.12 the daemon's sqlite store fails to load. `cctl doctor` checks the real
floor (`checkNodeVersion`), not the lenient `engines` field, so this is caught before
it turns into a confusing runtime error.

## Linux caveats

- **Autostart is not wired yet** (`cctl daemon install` is Scheduled-Task-based);
  run the daemon manually or under your own systemd user unit / shell profile for
  now.
- **Observed sessions** target ConPTY and stay Windows-only; everything else —
  daemon, CLI, usage polling, remote/managed sessions — runs as-is.

## macOS: implemented, unverified

macOS is **not a supported platform**, and it is also not absent — the docs should
imply neither extreme:

- **What exists.** `KeychainProtector` (vault key in the login Keychain, blobs sealed
  with the same AES-256-GCM primitive the Linux file-key protector uses) and
  `KeychainCredentialChannel` (on macOS the CLI keeps its live `claudeAiOauth` block in
  a Keychain item, not in `.credentials.json`, so a switch must content-swap the item).
  The platform dispatch in `switch-engine/src/protector.ts` selects both on `darwin`
  today, and `cctl doctor` names the exact Keychain service/account it targets so a
  wrong item name reads as a config problem rather than a mystery.
- **What is proven.** Unit tests only, driving a **fake `security(1)` runner**. They
  prove argument construction, the surgical read-modify-write of the item, payload-shape
  preservation, and error mapping. They prove nothing about how the real `security`
  binary or a real login Keychain behaves, because no test here has ever talked to one.
- **What is unproven.** Everything needing real hardware: the CLI's actual Keychain item
  name and payload shape, whether an isolated `CLAUDE_CONFIG_DIR` login lands in a file
  (which is what makes `cctl accounts add --fresh` safe), the switch round-trip, and the
  vault's negative invariant. The known-hard one: reading the CLI's **cross-app** item
  may raise a Keychain GUI prompt, and a headless daemon cannot answer a GUI prompt.
  There is no `security(1)`-path workaround for that — if it reproduces, the honest
  outcome is a documented caveat, not an ACL hack.

Until the _macOS support (Keychain vault + live-credential channel)_ section of
`docs/VERIFICATION.md` is confirmed on real hardware, macOS is unverified: the commands
may well work on your Mac, and nothing about them is claimed here.

On an unsupported platform, `cctl doctor` reports the gap instead of failing
silently, and setup can still run for anything platform-independent.
