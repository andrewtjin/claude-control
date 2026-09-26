// `cctl shell-init <shell>` — print a `claude` shell wrapper function that forwards to `cctl claude`.
//
// The wrapper is what makes folder bindings transparent: with it on PATH shadowing the real binary,
// typing `claude` in a bound folder automatically runs on that folder's account (and everywhere else
// runs on the global account), with no habit change. It is emitted as text the operator installs
// themselves (with the printed instructions) rather than written to a profile automatically —
// editing someone's shell profile without asking is not this tool's call.
//
// Each function calls `cctl claude` and forwards ALL arguments verbatim, so `--account` / `--override`
// and every Claude Code flag pass straight through.

export type SupportedShell = 'powershell' | 'bash' | 'zsh' | 'fish';

export const SUPPORTED_SHELLS: readonly SupportedShell[] = ['powershell', 'bash', 'zsh', 'fish'];

export function isSupportedShell(value: string): value is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(value);
}

/** The wrapper script for one shell, with install instructions as leading comments. Pure text. */
export function renderShellInit(shell: SupportedShell): string {
  switch (shell) {
    case 'powershell':
      // A function shadows the external `claude` in the session. `$args` forwards every argument
      // unmodified; `@args` (splatting) preserves argument boundaries so quoted args stay intact.
      return [
        '# cctl claude wrapper (PowerShell).',
        '# Add it to your profile so `claude` always runs on the right account:',
        '#   cctl shell-init powershell | Out-File -Append $PROFILE',
        '# then open a new shell (or: . $PROFILE).',
        'function claude {',
        '  cctl claude @args',
        '}',
        '',
      ].join('\n');
    case 'bash':
    case 'zsh': {
      const rc = shell === 'bash' ? '~/.bashrc' : '~/.zshrc';
      // "$@" forwards every argument with word boundaries preserved (never $* / unquoted $@).
      return [
        `# cctl claude wrapper (${shell}).`,
        '# Add it to your shell rc so `claude` always runs on the right account:',
        `#   cctl shell-init ${shell} >> ${rc}`,
        '# then open a new shell (or: source it).',
        'claude() {',
        '  command cctl claude "$@"',
        '}',
        '',
      ].join('\n');
    }
    case 'fish':
      // $argv forwards all arguments; fish preserves boundaries without extra quoting.
      return [
        '# cctl claude wrapper (fish).',
        '# Add it to your fish config so `claude` always runs on the right account:',
        '#   cctl shell-init fish >> ~/.config/fish/config.fish',
        '# then open a new shell.',
        'function claude',
        '  command cctl claude $argv',
        'end',
        '',
      ].join('\n');
  }
}
