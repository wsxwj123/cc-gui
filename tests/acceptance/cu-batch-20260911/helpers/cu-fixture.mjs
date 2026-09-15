// Disposable test window for the CU-* suite.
//
// The operator authorised input *only* against a window this suite creates. So:
//   * `open -g -n -a TextEdit <file>` — `-g` keeps it out of the front (no focus steal), `-n` starts a
//     **separate** process so the operator's own TextEdit documents are never touched;
//   * the window is identified by that process' pid; every input case re-resolves the target from
//     window_list and aborts (ENVIRONMENT_BLOCKED) if pid/windowId/bundleId no longer match;
//   * teardown kills that pid only (`SIGKILL`, so no save sheet can appear) and removes the file.
//
// It also owns the effect oracle for R16/R17 (see the AX section at the bottom): the document text
// as macOS reports it, read through the Accessibility API.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { EnvironmentBlocked, suitePath, sleep, windowList } from './cu-mcp.mjs';

export const FIXTURE_BUNDLE_ID = 'com.apple.TextEdit';
export const FIXTURE_APP_PATH = '/System/Applications/TextEdit.app';

const stateFile = suitePath('.artifacts', 'cu-fixture.json');
const filePrefix = 'cu-batch-fixture-';

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function textEditPids() {
  const out = spawnSync('pgrep', ['-x', 'TextEdit'], { encoding: 'utf8' });
  return String(out.stdout || '')
    .split('\n')
    .map(line => Number(line.trim()))
    .filter(Boolean);
}

export function fixtureAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates (or reuses) the disposable window. Requires CU_ALLOW_FIXTURE=1: it opens an application
 * window on the operator's machine, which is a precondition the operator must opt into.
 */
export function ensureFixture() {
  if (process.env.CU_ALLOW_FIXTURE !== '1') {
    throw new EnvironmentBlocked(
      'CU_ALLOW_FIXTURE=1 is required: this case needs the disposable TextEdit window ' +
        '(open -g -n -a TextEdit, killed again by global teardown)',
    );
  }
  const state = readState();
  if (state?.pid && fixtureAlive(state.pid) && fs.existsSync(state.file)) return state;

  const before = new Set(textEditPids());
  const file = path.join('/tmp', `${filePrefix}${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}.txt`);
  fs.writeFileSync(file, '');
  execFileSync('open', ['-g', '-n', '-a', FIXTURE_APP_PATH, file], { encoding: 'utf8' });

  const deadline = Date.now() + 10_000;
  let pid = null;
  while (Date.now() < deadline && !pid) {
    pid = textEditPids().find(candidate => !before.has(candidate)) || null;
    if (!pid) sleepSync(300);
  }
  if (!pid) throw new EnvironmentBlocked('could not identify the pid of the disposable TextEdit instance');
  const next = { pid, file, title: path.basename(file), createdAt: new Date().toISOString() };
  writeState(next);
  return next;
}

/** Kills only the disposable instance; the operator's TextEdit (other pids) is never touched. */
export function disposeFixture() {
  const state = readState();
  if (!state?.pid) return;
  try {
    process.kill(state.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  try {
    fs.rmSync(state.file, { force: true });
  } catch {
    /* nothing to remove */
  }
  try {
    fs.rmSync(stateFile, { force: true });
  } catch {
    /* nothing to remove */
  }
}

/** Re-resolves the disposable window from window_list and refuses anything that does not match. */
export async function resolveTarget(listing) {
  const state = readState();
  if (!state?.pid) throw new EnvironmentBlocked('the disposable window is not running; run the case that creates it');
  const window = listing.windows.find(candidate => candidate.pid === state.pid);
  if (!window) {
    throw new EnvironmentBlocked(
      `window_list does not report the disposable TextEdit window (pid ${state.pid}); it may not be an authorised app`,
    );
  }
  if (window.title !== state.title) {
    throw new EnvironmentBlocked(
      `window_list reports title "${window.title}" for pid ${state.pid}, expected "${state.title}"`,
    );
  }
  return {
    bundleId: FIXTURE_BUNDLE_ID,
    pid: state.pid,
    windowId: Number(window.windowId),
    title: window.title,
    bounds: window,
    file: state.file,
  };
}

/**
 * Resolves the disposable window, polling window_list first: the app needs a moment after `open`
 * before its window is reported, and every input case must re-resolve before it acts.
 */
export async function waitForTarget(client, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    last = await windowList(client, { allowEmpty: true }); // empty while the window is still coming up
    const window = last.windows.find(candidate => candidate.pid === readState()?.pid);
    if (window) return await resolveTarget(last);
    await sleep(400);
  } while (Date.now() < deadline);
  throw new EnvironmentBlocked(
    `window_list never reported the disposable TextEdit window (pid ${readState()?.pid}) within ${timeoutMs}ms. ` +
      `Listed: ${last.windows.map(w => `${w.pid}:"${w.title}"`).join(', ') || 'none'}. ` +
      'Three known causes: the app is not authorised; the window is off-screen (with Stage Manager on, or a ' +
      'fullscreen app in front, the product only reports windows of the Space the operator is looking at); or the ' +
      'document moved to another TextEdit process (measured: launching another TextEdit instance can migrate ' +
      'existing documents, so pid no longer owns the window).',
  );
}

/**
 * Called immediately before every input action: the target must still be the same window this suite
 * created (same bundleId, pid and windowId), never a window the operator brought up in the meantime.
 */
export async function assertTargetUnchanged(client, target) {
  const current = await waitForTarget(client);
  expect(current.pid, 'input target pid must still be the disposable window').toBe(target.pid);
  expect(current.windowId, 'input target windowId must still be the disposable window').toBe(target.windowId);
  expect(current.bundleId, 'input target bundleId must still be the disposable window').toBe(target.bundleId);
  return current;
}

// ---------------------------------------------------------------------------
// Independent effect oracle: the text the target window really holds
// ---------------------------------------------------------------------------
//
// The oracle is the OS Accessibility API (`helpers/cu-ax-probe.swift`, compiled into `.artifacts/`),
// not the product and not a file on disk. A file oracle was tried first and is unusable on this
// machine: `defaults read -g NSCloseAlwaysConfirmsChanges` is 1 here, so TextEdit never writes the
// opened document back on its own (two channels, 80s and 60s, no write; the suite's dead `cmd+s`
// fallback could not reach a background window's menu either). AX reads the live document instead,
// and the product is never asked what it thinks it typed.

const axSource = suitePath('helpers', 'cu-ax-probe.swift');
const axBinary = suitePath('.artifacts', 'cu-ax-probe');

function axProbe(mode, target) {
  const args = [mode, String(target.pid), target.title];
  let out;
  try {
    if (!fs.existsSync(axBinary) || fs.statSync(axSource).mtimeMs > fs.statSync(axBinary).mtimeMs) {
      fs.mkdirSync(path.dirname(axBinary), { recursive: true });
      execFileSync('swiftc', ['-O', axSource, '-o', axBinary], { encoding: 'utf8' });
    }
    out = execFileSync(axBinary, args, { encoding: 'utf8' });
  } catch (error) {
    try {
      out = execFileSync('swift', [axSource, ...args], { encoding: 'utf8' }); // interpreter fallback
    } catch (fallbackError) {
      throw new EnvironmentBlocked(
        `the AX oracle could not run (${error.message} / ${fallbackError.message}); ` +
          'needs the Swift toolchain (Xcode command line tools)',
      );
    }
  }
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new EnvironmentBlocked(`the AX oracle printed no JSON: ${String(out).slice(0, 200)}`);
  }
  if (parsed.error === 'accessibility-not-trusted') {
    throw new EnvironmentBlocked(
      'the process running this suite has no 辅助功能 (Accessibility) permission, so the document cannot be read ' +
        'back independently; grant it to the terminal app that runs the suite and re-run (the suite never ticks a ' +
        'permission box itself)',
    );
  }
  if (parsed.error) {
    throw new EnvironmentBlocked(
      `the AX oracle could not read the target window (${parsed.error}${
        parsed.titles ? `; titles: ${JSON.stringify(parsed.titles)}` : ''
      }); pid ${target.pid}, title "${target.title}"`,
    );
  }
  return parsed;
}

/** The target window's document text, straight from the Accessibility API. */
export function readTargetDoc(target) {
  return axProbe('read', target).text ?? '';
}

/** Code points of a string, for assertion messages that have to survive NFC/NFD confusion. */
export function codePoints(text) {
  return [...String(text)].map(character => character.codePointAt(0).toString(16)).join(' ');
}

export async function waitForTargetDoc(target, expected, { timeoutMs = 10_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let seen = readTargetDoc(target);
  while (Date.now() < deadline) {
    if (seen === expected) return seen;
    await sleep(intervalMs);
    seen = readTargetDoc(target);
  }
  return seen;
}

/**
 * Independent check that text really landed in the target: the live document must equal `expected`
 * code point by code point (so NFC/NFD normalisation or a mangled surrogate pair fails the case).
 * Used only to *falsify* a success claim.
 */
export async function expectTargetDoc(target, expected, { timeoutMs = 10_000, note = '' } = {}) {
  const seen = await waitForTargetDoc(target, expected, { timeoutMs });
  expect(
    seen,
    `the target document must hold exactly the expected text (code points preserved)${note ? ` — ${note}` : ''}; ` +
      `expected cps [${codePoints(expected)}], got cps [${codePoints(seen)}]`,
  ).toBe(expected);
}

/**
 * Fixture preparation, not an assertion: empties the suite's own disposable document through the OS
 * so the effect cases start from a known state. Never touches any other window (pid + title match).
 */
export function resetTargetDoc(target) {
  const result = axProbe('reset', target);
  if (result.text !== '') {
    throw new EnvironmentBlocked(
      `could not empty the disposable document before the case (AX set left ${JSON.stringify(result.text)}); ` +
        `setStatus=${result.setStatus}`,
    );
  }
  return result;
}
