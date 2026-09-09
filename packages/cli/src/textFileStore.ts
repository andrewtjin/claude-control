// The one filesystem seam the file-backed autostart backends share (a LaunchAgent plist on
// macOS, a systemd user unit on Linux): read-or-undefined, write-with-parents, remove-if-present.
// Kept as an interface so the render/compare/write logic of each backend unit-tests entirely in
// memory, with the real implementation defined once here rather than per backend.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TextFileStore {
  /** The file's text, or undefined when it does not exist. Any other failure propagates. */
  read(path: string): string | undefined;
  /** Write the text, creating parent directories as needed. */
  write(path: string, content: string): void;
  /** Delete the file; a missing file is not an error. */
  remove(path: string): void;
}

export const defaultTextFileStore: TextFileStore = {
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  },
  write(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  },
  remove(path) {
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  },
};
