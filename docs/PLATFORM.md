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

## Coming later

- **macOS** (Keychain-backed vault) is the next planned milestone; its own gated
  verification tracks separately and does not block anything documented here.

On an unsupported platform, `cctl doctor` reports the gap instead of failing
silently, and setup can still run for anything platform-independent.
