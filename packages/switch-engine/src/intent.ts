// Write-ahead switch intent.
//
// Before the switch engine touches a live credential file it records what it is about to
// do. If the process dies mid-switch, the next startup reads this record and either rolls
// the operation forward (the new credentials are already live and valid) or back (restore
// the previous account). The record carries NO secrets — only ids, a phase, and whether an
// encrypted rollback snapshot exists.

import { join } from 'node:path';
import type { SwitchIntent } from './types.js';
import { atomicWriteFile, readJsonIfExists, removeIfExists } from './fsutil.js';

const INTENT_FILE = '.switch-intent.json';

/** Persists the single in-flight {@link SwitchIntent} inside the vault directory. */
export class IntentStore {
  private readonly path: string;

  constructor(vaultDir: string) {
    this.path = join(vaultDir, INTENT_FILE);
  }

  /** Persist (or overwrite) the current intent. */
  async write(intent: SwitchIntent): Promise<void> {
    await atomicWriteFile(this.path, JSON.stringify(intent));
  }

  /** Read the in-flight intent, or `undefined` if no switch is pending. */
  async read(): Promise<SwitchIntent | undefined> {
    return readJsonIfExists<SwitchIntent>(this.path);
  }

  /** Clear the intent — called once a switch commits or is fully rolled back. */
  async clear(): Promise<void> {
    await removeIfExists(this.path);
  }
}
