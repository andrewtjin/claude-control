# Platform support

**Windows-only today.** Two load-bearing places tie the implementation to Windows:

- **Credential vault encryption** uses Windows DPAPI (via PowerShell `ProtectedData`,
  `CurrentUser` scope) — there is no macOS/Linux equivalent wired in yet, so the vault
  cannot protect tokens off Windows. `cctl doctor` runs a real protect/unprotect
  round-trip through this platform's protector and reports the gap outright on an
  unsupported platform, instead of failing silently later.
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

## Coming later

- **macOS** (Keychain-backed vault) is the next planned milestone; its own gated
  verification tracks separately and does not block anything documented here.
- **Linux** (libsecret-backed vault) after that.

On an unsupported platform, `cctl doctor` reports the gap instead of failing
silently, and setup can still run for anything platform-independent.
