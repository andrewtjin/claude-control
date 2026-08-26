// Append-only switch audit trail.
//
// Every activation (and its outcome) is appended as one JSON line to `switch-audit.jsonl`.
// This is the ground-truth record of when each account was live — the daemon's usage
// attribution joins against it, and it is the first thing to read when a switch misbehaves.
// Append-only by design: history is never rewritten.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from './fsutil.js';

/** Who/what initiated a switch — stamped on `activated` entries (see `SwitchEngine.activate`'s
 *  `origin` option) and on the entries `recover()` writes for its own crash-recovery commits
 *  ('recovery'). Absent on every entry written before this field existed, and on any entry type
 *  that never carried a caller-supplied origin (quarantine, refresh-adopt, ...). */
export type SwitchOrigin = 'auto' | 'manual' | 'phone' | 'recovery';

export interface AuditEntry {
  ts: number;
  event:
    | 'activated'
    | 'quarantined'
    | 'recovered'
    | 'refresh_adopted'
    | 'refreshed'
    | 'relogin_live_heal';
  fromAccountId: string | null;
  toAccountId: string | null;
  detail?: string;
  origin?: SwitchOrigin;
}

/** Appends audit entries to `<vaultDir>/switch-audit.jsonl`. */
export class AuditLog {
  private readonly path: string;

  constructor(vaultDir: string) {
    this.path = join(vaultDir, 'switch-audit.jsonl');
  }

  append(entry: AuditEntry): void {
    ensureDir(join(this.path, '..'));
    appendFileSync(this.path, JSON.stringify(entry) + '\n');
  }
}
