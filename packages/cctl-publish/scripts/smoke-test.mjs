#!/usr/bin/env node
// Prepublish smoke test: proves the bundle actually WORKS standalone, not just that esbuild
// exited zero. Stages a throwaway directory outside the workspace holding dist/bin.js and a
// node_modules containing exactly what this package DECLARES as dependencies — no pnpm
// symlinks, no workspace tree above it — then checks three things a user hits in order:
//
//   1. the bundle boots (`--version`, `--help`), i.e. nothing it imports is missing;
//   2. the Agent SDK can find its native Claude Code binary from that layout; and
//   3. `cctl channel serve` answers MCP over stdio, and still refuses when unidentified.
//
// Check (2) exists because check (1) cannot see it. The SDK does not implement Claude Code — it
// spawns a ~250MB per-platform native binary shipped as a separate package, located at CALL
// time (not import time) by `createRequire(import.meta.url).resolve(...)` from wherever the
// SDK's own module sits. So a build that cannot reach that binary boots perfectly, passes
// --version, publishes green — and then fails on the user's first session with "Native CLI
// binary for <platform>-<arch> not found", a runtime-only failure of exactly one feature
// (starting sessions) on exactly the machines nobody tested: freshly installed ones. Check (2)
// re-runs that lookup from the staged layout, which is the cheapest honest stand-in for a real
// `npm i -g` short of installing from the registry.
//
// Check (3) covers the one command in the bundle that Claude Code starts by itself, over stdio,
// with nobody watching (the shipped plugin's .mcp.json invokes `cctl channel serve`). A break
// there produces no failing command and no error anybody reads — sessions simply never get a
// channel. Two questions, both answerable without a daemon, a session or a config directory: does
// `initialize` come back (the composition defers almost everything behind lazy imports, and a
// dynamic import esbuild rewrote wrongly would fail HERE and nowhere else), and does `reply` still
// refuse when the server could not work out which session it belongs to — the fail-closed rule
// that separates "this session has no channel" from "one operator's prompt in another's terminal".
//
// Deliberately does NOT run `doctor`: doctor probes REAL machine surfaces (DPAPI, the vault
// key store, live credentials) and on CI's ubuntu runner it would even create a real key
// file in the runner's home — a smoke test must stay side-effect-free.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  copyFileSync,
  linkSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(here, '../dist/bin.js');
const resolveFromHere = createRequire(import.meta.url);

if (!existsSync(bundlePath)) {
  process.stderr.write(`error: ${bundlePath} does not exist — run the build first.\n`);
  process.exit(1);
}

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const ownManifest = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8'));
const declaredDependencies = Object.keys(ownManifest.dependencies ?? {});

// A prefix under the OS temp dir, well outside the repo/workspace, so nothing here can
// accidentally resolve back into packages/*/node_modules.
const cleanDir = mkdtempSync(join(tmpdir(), 'cctl-smoke-'));
const modulesDir = join(cleanDir, 'node_modules');
const stagedBundle = join(cleanDir, 'bin.js');

let failed = false;
const fail = (message) => {
  failed = true;
  process.stderr.write(`error: ${message}\n`);
};

/** The native binary packages that could serve THIS host, `<package name>` → `<binary file>`,
 *  in the order the SDK itself would try them: the plain `<platform>-<arch>` build first, then
 *  the musl build an Alpine host would carry. Read from the SDK's shipped manifest rather than
 *  hardcoded, so a future platform or a renamed binary needs no edit here. */
function hostBinaryCandidates() {
  const sdkEntry = resolveFromHere.resolve(SDK_PACKAGE);
  const { platforms } = JSON.parse(readFileSync(join(dirname(sdkEntry), 'manifest.json'), 'utf8'));
  return [`${process.platform}-${process.arch}`, `${process.platform}-${process.arch}-musl`]
    .filter((key) => platforms[key] !== undefined)
    .map((key) => [`${SDK_PACKAGE}-${key}`, platforms[key].binary]);
}

/** Stage the per-platform native binary package the Agent SDK spawns. It is an OPTIONAL
 *  dependency of the SDK, so staging the declared list does not bring it along, and walking the
 *  full dependency graph is npm's job — this is the only native package in it. The binary is
 *  hardlinked where the filesystem allows: it is ~250MB and this runs on every publish and
 *  every CI job. */
function stageNativeBinaryPackage(candidates) {
  // Resolve the platform package FROM THE SDK, never from this script: it is the SDK's own
  // optional dependency, so under pnpm's strict layout it is visible inside the SDK's tree and
  // nowhere else — which is also precisely where the SDK looks for it at runtime.
  const resolveFromSdk = createRequire(resolveFromHere.resolve(SDK_PACKAGE));
  const found = candidates
    .map(([name, binary]) => {
      try {
        return { name, binary, dir: dirname(resolveFromSdk.resolve(`${name}/package.json`)) };
      } catch {
        return undefined;
      }
    })
    .find((candidate) => candidate !== undefined);
  if (found === undefined) {
    fail(
      `no native binary package installed for ${process.platform}-${process.arch} — expected ` +
        `one of ${candidates.map(([name]) => name).join(', ')}. Reinstall without --omit=optional.`,
    );
    return;
  }

  const targetDir = join(modulesDir, found.name);
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(found.dir, 'package.json'), join(targetDir, 'package.json'));
  try {
    linkSync(join(found.dir, found.binary), join(targetDir, found.binary));
  } catch {
    // Different volume, or a filesystem without hardlinks: pay the copy.
    copyFileSync(join(found.dir, found.binary), join(targetDir, found.binary));
  }
}

/**
 * The probe run inside the staged tree, reproducing the SDK's own binary lookup.
 *
 * It first finds the directory the SDK's module will occupy at RUNTIME, because that — not the
 * bundle's directory — is where its `createRequire(import.meta.url)` starts searching. Two
 * shapes are possible and the probe must judge both, which is why it derives the root instead
 * of being handed one: when the SDK is external (correct) the root is the installed package
 * entry; when it has been bundled INTO bin.js the root is the bundle itself, whose directory
 * has no native package beside it — the exact defect this check exists to catch, and one that
 * would otherwise sail through every other check in this file.
 *
 * Spawned as a file rather than evaluated here so all resolution starts inside the staged tree.
 */
const NATIVE_BINARY_PROBE = `
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';

const bundle = process.argv[2];
let root = bundle;
let shape = 'bundled into bin.js';
try {
  root = createRequire(bundle).resolve(${JSON.stringify(SDK_PACKAGE)});
  shape = 'installed package';
} catch {}

const resolveFromRoot = createRequire(root);
let resolved;
for (const [name, binary] of CANDIDATES) {
  try {
    resolved = resolveFromRoot.resolve(name + '/' + binary);
    break;
  } catch {}
}
if (resolved === undefined) {
  throw new Error(
    'native CLI binary not resolvable from the ' + shape + ' at ' + root +
      ' (tried ' + CANDIDATES.map(([name]) => name).join(', ') + ')',
  );
}
const { size } = statSync(resolved);
if (size === 0) throw new Error('native CLI binary is empty: ' + resolved);
process.stdout.write(resolved + ' (' + Math.round(size / 1048576) + 'MB, via ' + shape + ')');
`;

/** How long the channel probe will wait for the server to finish identifying itself. Generous
 *  relative to what it measures (a few lazy imports), tight enough that a hung server fails the
 *  publish instead of stalling it. */
const CHANNEL_PROBE_TIMEOUT_MS = 30_000;

/**
 * Drive `cctl channel serve` over a real stdio pipe, exactly the way Claude Code does.
 *
 * Hermetic by construction: `CLAUDE_CONFIG_DIR` points at an empty directory inside the staged
 * tree, so there is no session registry to read, no daemon to find and nothing on the real machine
 * to touch. That absence is also the second half of the check — with no registry the server cannot
 * establish which session it belongs to, and the rule is that it keeps serving the protocol while
 * accepting nothing. A server that answered `reply` here would be one that attaches to a guess,
 * which delivers one operator's message into a different session's terminal.
 */
async function probeChannelServe() {
  const configDir = join(cleanDir, 'claude-config');
  mkdirSync(configDir, { recursive: true });
  const child = spawn(process.execPath, [stagedBundle, 'channel', 'serve'], {
    cwd: cleanDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });

  const frames = [];
  let stderr = '';
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    // Newline-delimited JSON, and stdout is the WIRE: anything on it that is not a frame is
    // itself the defect (a stray `console.log` in the bundle breaks every session's channel).
    let index = buffered.indexOf('\n');
    while (index !== -1) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (line.length > 0) {
        try {
          frames.push(JSON.parse(line));
        } catch {
          fail(`cctl channel serve wrote a non-JSON line to the MCP wire: ${line}`);
        }
      }
      index = buffered.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (stderr += chunk));

  const say = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitForFrame = async (match) => {
    const deadline = Date.now() + CHANNEL_PROBE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const found = frames.find(match);
      if (found !== undefined) return found;
      if (child.exitCode !== null) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  };

  try {
    say({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    say({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const initialized = await waitForFrame((frame) => frame.id === 1);
    if (initialized?.result?.serverInfo?.name === undefined) {
      fail(
        'cctl channel serve never answered `initialize` — Claude Code would show a broken MCP ' +
          `server and no session would get a channel.\nstderr: ${stderr}`,
      );
      return;
    }
    process.stdout.write(
      `ok: cctl channel serve -> ${initialized.result.serverInfo.name} ` +
        `${initialized.result.serverInfo.version}\n`,
    );

    // Identity resolution runs behind the handshake, so the refusal is not necessarily in place
    // the instant `initialize` is answered; ask until it is, or until the bound says it never
    // will be. Each attempt is a fresh id so the answers cannot be confused for one another.
    const deadline = Date.now() + CHANNEL_PROBE_TIMEOUT_MS;
    let lastAnswer = '';
    for (let id = 2; Date.now() < deadline; id += 1) {
      say({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'reply', arguments: { text: 'smoke test' } },
      });
      const answer = await waitForFrame((frame) => frame.id === id);
      lastAnswer = answer?.result?.content?.[0]?.text ?? '';
      if (answer?.result?.isError === true && /could not be identified/.test(lastAnswer)) {
        process.stdout.write('ok: cctl channel serve refuses to accept work unidentified\n');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    fail(
      'cctl channel serve did not refuse `reply` with no session registry to identify itself ' +
        `from — the fail-closed rule is what keeps one operator's prompt out of another ` +
        `session's terminal.\nlast answer: ${lastAnswer}\nstderr: ${stderr}`,
    );
  } finally {
    // Closing stdin is how Claude Code ends this process; killing it is the backstop.
    child.stdin.end();
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!exited) child.kill();
  }
}

try {
  const candidates = hostBinaryCandidates();
  copyFileSync(bundlePath, stagedBundle);

  // Stage every DECLARED dependency, as REAL files (`dereference`) rather than symlinks back
  // into the pnpm store — the distinction matters because the SDK resolves its binary relative
  // to its own realpath. Reading the list from package.json rather than naming packages here is
  // what makes this a regression test: undeclare something the bundle needs and nothing gets
  // staged for it, so the boot check below fails instead of the user's machine.
  for (const name of declaredDependencies) {
    const target = join(modulesDir, name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(dirname(resolveFromHere.resolve(name)), target, { recursive: true, dereference: true });
  }
  if (declaredDependencies.includes(SDK_PACKAGE)) stageNativeBinaryPackage(candidates);

  // (1) Boot the bundle the way a fresh `npm i -g @andrewtjin/cctl` install would invoke it. If
  // it secretly still depended on a workspace-relative resolve (a missed `external`, an
  // undeclared dependency, a path that only exists inside this monorepo), it fails here.
  for (const args of [['--version'], ['--help']]) {
    const result = spawnSync(process.execPath, [stagedBundle, ...args], {
      cwd: cleanDir,
      encoding: 'utf8',
    });
    const label = `bin.js ${args.join(' ')}`;
    if (result.error) {
      fail(`${label} failed to spawn: ${result.error.message}`);
      continue;
    }
    if (result.status !== 0) {
      fail(`${label} exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      continue;
    }
    process.stdout.write(`ok: ${label} -> ${result.stdout.trim()}\n`);
  }

  // (2) The binary lookup every session start depends on. Runs UNCONDITIONALLY — gating it on
  // the SDK being a declared dependency would make the check disappear in precisely the state
  // it is meant to reject. Skipped only when the boot check already failed, since the staged
  // tree is known-broken by then and a second failure would just add noise.
  if (!failed) {
    const probePath = join(cleanDir, 'probe.mjs');
    writeFileSync(
      probePath,
      `const CANDIDATES = ${JSON.stringify(candidates)};\n${NATIVE_BINARY_PROBE}`,
    );
    const probe = spawnSync(process.execPath, [probePath, stagedBundle], {
      cwd: cleanDir,
      encoding: 'utf8',
    });
    if (probe.status !== 0) {
      fail(
        'the Agent SDK cannot find its native Claude Code binary from the installed layout — ' +
          'sessions would fail at runtime while every other command still worked.\n' +
          `stderr: ${probe.stderr}`,
      );
    } else {
      process.stdout.write(`ok: native CLI binary resolves -> ${probe.stdout.trim()}\n`);
    }
  }

  // (3) The MCP server Claude Code spawns per session. Same skip rule as (2).
  if (!failed) await probeChannelServe();
} finally {
  // Never leaves the staged tree behind, pass or fail.
  rmSync(cleanDir, { recursive: true, force: true });
}

if (failed) {
  process.stderr.write('smoke test failed.\n');
  process.exit(1);
}
process.stdout.write(
  'smoke test passed: bundle boots standalone, can start sessions, and serves the channel.\n',
);
