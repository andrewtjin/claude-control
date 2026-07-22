import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookEndpointPath, readHookEndpoint, writeHookEndpoint } from './hookEndpoint.js';

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hook-endpoint-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe('hookEndpoint', () => {
  it('round-trips a published port', async () => {
    const dir = await tempDir();
    const path = hookEndpointPath(dir);
    await writeHookEndpoint(path, { port: 54321 });
    expect(await readHookEndpoint(path)).toEqual({ port: 54321 });
  });

  it('returns undefined when nothing was ever published (daemon never ran)', async () => {
    const dir = await tempDir();
    expect(await readHookEndpoint(hookEndpointPath(dir))).toBeUndefined();
  });

  it('treats a corrupt (half-written) file as "no endpoint" rather than throwing', async () => {
    const dir = await tempDir();
    const path = hookEndpointPath(dir);
    await writeFile(path, '{"port": 5432', 'utf8'); // truncated JSON
    expect(await readHookEndpoint(path)).toBeUndefined();
  });

  it('rejects a non-positive / non-integer port', async () => {
    const dir = await tempDir();
    const path = hookEndpointPath(dir);
    await writeFile(path, JSON.stringify({ port: 0 }), 'utf8');
    expect(await readHookEndpoint(path)).toBeUndefined();
    await writeFile(path, JSON.stringify({ port: -1 }), 'utf8');
    expect(await readHookEndpoint(path)).toBeUndefined();
    await writeFile(path, JSON.stringify({ port: 1.5 }), 'utf8');
    expect(await readHookEndpoint(path)).toBeUndefined();
  });

  it('overwrites a previous publication (current port wins across restarts)', async () => {
    const dir = await tempDir();
    const path = hookEndpointPath(dir);
    await writeHookEndpoint(path, { port: 1111 });
    await writeHookEndpoint(path, { port: 2222 });
    expect(await readHookEndpoint(path)).toEqual({ port: 2222 });
  });
});
