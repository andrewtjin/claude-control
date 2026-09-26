import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from './vault.js';
import { buildFolderBindingSnapshot, readFolderBindingSnapshot } from './folderBindings.js';
import { folderBindingsPath, groupProfileDir } from './paths.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { VaultError } from './errors.js';
import type { CredentialBundle, StoredGroup } from './types.js';

let dirs: string[] = [];
async function vaultAt() {
  const dir = await mkdtemp(join(tmpdir(), 'ce-fb-'));
  dirs.push(dir);
  let t = 1000;
  const vaultDir = join(dir, 'vault');
  return {
    v: new Vault(vaultDir, new InsecurePassthroughProtector(), () => t++, undefined, 'win32'),
    vaultDir,
    snapshotPath: folderBindingsPath(vaultDir),
  };
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const bundle = (token: string): CredentialBundle => ({
  claudeAiOauth: { accessToken: token, refreshToken: 'r-' + token, expiresAt: 999 },
  oauthAccount: { accountUuid: 'uuid-' + token, emailAddress: token + '@x.com' },
});

describe('buildFolderBindingSnapshot (pure)', () => {
  it('projects groups to {folders, profileDir, member LABELS} and carries the envelope fields', () => {
    const groups: StoredGroup[] = [
      {
        id: 'g1',
        label: 'Work',
        members: [
          {
            id: 'm1',
            label: 'jina',
            accountUuid: 'uuid-1',
            quarantined: false,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
          { id: 'm2', label: 'debate', quarantined: false, createdAtMs: 1, updatedAtMs: 1 },
        ],
        activeId: 'm1',
        folders: ['C:\\work'],
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ];
    const snapshot = buildFolderBindingSnapshot({
      groups,
      generation: 7,
      enforce: 'block',
      mainConfigDir: 'C:\\Users\\me\\.claude',
      profileDirOf: (id) => `C:\\profiles\\${id}`,
    });
    expect(snapshot).toEqual({
      schemaVersion: 1,
      generation: 7,
      enforce: 'block',
      mainConfigDir: 'C:\\Users\\me\\.claude',
      groups: [
        {
          id: 'g1',
          label: 'Work',
          profileDir: 'C:\\profiles\\g1',
          folders: ['C:\\work'],
          members: ['jina', 'debate'],
        },
      ],
    });
  });

  it('carries no member ids and no token material', () => {
    const groups: StoredGroup[] = [
      {
        id: 'g1',
        label: 'Work',
        members: [
          {
            id: 'secret-id',
            label: 'jina',
            accountUuid: 'uuid-secret',
            quarantined: false,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
        activeId: null,
        folders: ['C:\\work'],
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ];
    const text = JSON.stringify(
      buildFolderBindingSnapshot({
        groups,
        generation: 1,
        enforce: 'warn',
        mainConfigDir: 'C:\\m',
        profileDirOf: (id) => id,
      }),
    );
    expect(text).not.toContain('secret-id');
    expect(text).not.toContain('uuid-secret');
    expect(text).toContain('jina');
  });
});

describe('Vault.writeFolderBindings / readFolderBindings', () => {
  it('writes the snapshot beside the vault and reads it back with the live generation', async () => {
    const { v, vaultDir, snapshotPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const group = await v.createGroup({ memberIds: [a.id], folders: ['C:\\work'] });

    const written = await v.writeFolderBindings({ enforce: 'block', mainConfigDir: 'C:\\main' });
    expect(written.generation).toBe(await v.getGroupsGeneration());
    expect(written.groups[0]?.profileDir).toBe(groupProfileDir(vaultDir, group.id));
    expect(written.groups[0]?.members).toEqual(['a']);

    const readBack = await v.readFolderBindings();
    expect(readBack).toEqual(written);
    // The file really is at the sibling location, not inside the vault dir.
    expect(await readFile(snapshotPath, 'utf8')).toContain('"schemaVersion": 1');
  });

  it('returns undefined when the snapshot was never written', async () => {
    const { v } = await vaultAt();
    expect(await v.readFolderBindings()).toBeUndefined();
  });
});

describe('readFolderBindingSnapshot — strict for trusted callers', () => {
  it('refuses an unsupported schemaVersion', async () => {
    const { snapshotPath } = await vaultAt();
    await writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 2,
        generation: 1,
        enforce: 'off',
        mainConfigDir: 'x',
        groups: [],
      }),
      'utf8',
    );
    await expect(readFolderBindingSnapshot(snapshotPath)).rejects.toThrow(VaultError);
    await expect(readFolderBindingSnapshot(snapshotPath)).rejects.toThrow(/schemaVersion/);
  });

  it('refuses an unknown enforce mode', async () => {
    const { snapshotPath } = await vaultAt();
    await writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        enforce: 'nope',
        mainConfigDir: 'x',
        groups: [],
      }),
      'utf8',
    );
    await expect(readFolderBindingSnapshot(snapshotPath)).rejects.toThrow(/enforce/);
  });

  it('refuses a non-integer generation', async () => {
    const { snapshotPath } = await vaultAt();
    await writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        generation: 'x',
        enforce: 'off',
        mainConfigDir: 'x',
        groups: [],
      }),
      'utf8',
    );
    await expect(readFolderBindingSnapshot(snapshotPath)).rejects.toThrow(/generation/);
  });
});
