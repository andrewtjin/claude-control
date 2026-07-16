// Append-only switch audit trail.
//
// Every activation (and its outcome) is appended as one JSON line to `switch-audit.jsonl`.
// This is the ground-truth record of when each account was live — the daemon's usage
// attribution joins against it, and it is the first thing to read when a switch misbehaves.
// Append-only by design: history is never rewritten.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from './fsutil.js';

export interface AuditEntry {
  ts: number;
  event: 'activated' | 'quarantined' | 'recovered' | 'refresh_adopted';
  fromAccountId: string | null;
  toAccountId: string | null;
  detail?: string;
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
