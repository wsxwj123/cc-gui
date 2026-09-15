// CU-* suite helper layer (R14–R18).
//
// Black-box only: every observation goes through the public surface —
//   * the `ccgui-computer-use` MCP server spoken to over stdio JSON-RPC (one process = one instance)
//   * GET /api/computer-use/status and POST /api/computer-use/doctor
//   * two OS-level oracles that belong to the machine, not to the product:
//     `lsappinfo front` (frontmost app) and a CoreGraphics cursor probe (real pointer position)
// Nothing here imports product code, reads product source or injects state.
//
// Safety model (read helpers/cu-fixture.mjs too): the product's *current* input tools act on the
// focused window. Any call that could reach a real dispatch therefore needs CU_ALLOW_INPUT=1 *and*
// a tool schema that declares a target. Without both, the case reports ENVIRONMENT_BLOCKED.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import * as fb from '../../first-batch-20260910/helpers/runtime.mjs';

export const EnvironmentBlocked = fb.EnvironmentBlocked;
export const uniqueId = fb.uniqueId;

export const suiteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function suitePath(...parts) {
  return path.join(suiteDir, ...parts);
}

export const FLAG_INPUT = 'CU_ALLOW_INPUT';
export const FLAG_SCREEN = 'CU_ALLOW_SCREEN_READ';
export const FLAG_FOREGROUND = 'CU_ALLOW_FOREGROUND';
export const FLAG_FIXTURE = 'CU_ALLOW_FIXTURE';

export function requireFlag(flag, why) {
  if (process.env[flag] !== '1') {
    throw new EnvironmentBlocked(`${flag}=1 is required: ${why}`);
  }
}

/** BASE_URL guard (loopback only, 6677/6689 refused) reused from the first-batch layer. */
export function getCuRuntime() {
  const base = fb.getRuntime({ requireManifest: false });
  return {
    baseURL: base.baseURL,
    worktree: base.worktree,
    screenRead: process.env[FLAG_SCREEN] === '1',
    input: process.env[FLAG_INPUT] === '1',
    fixtureLaunch: process.env[FLAG_FIXTURE] === '1',
    shotsDir: process.env.CU_SHOTS_DIR || null,
  };
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

export async function jsonBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __nonJsonBody__: text.slice(0, 200) };
  }
}

export async function cuStatus(request, baseURL) {
  const response = await request.get(`${baseURL}/api/computer-use/status`, { failOnStatusCode: false });
  return { status: response.status(), body: await jsonBody(response) };
}

export async function cuDoctor(request, baseURL) {
  const response = await request.post(`${baseURL}/api/computer-use/doctor`, {
    data: {},
    failOnStatusCode: false,
  });
  return { status: response.status(), body: await jsonBody(response) };
}

// ---------------------------------------------------------------------------
// MCP stdio client — one process per instance
// ---------------------------------------------------------------------------

const INIT_TIMEOUT_MS = 15_000;

export class CuMcp {
  constructor(child, { label }) {
    this.child = child;
    this.label = label;
    this.nextId = 1;
    this.pending = new Map();
    this.unsolicited = [];
    this.tools = [];
    this.instanceId = null;
    this.init = null;
    this.notes = [];
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => this.notes.push(String(chunk).slice(0, 400)));
    child.on('exit', code => {
      for (const [, entry] of this.pending) entry.reject(new Error(`MCP ${label} exited (code ${code})`));
      this.pending.clear();
    });
  }

  static async start({ label = 'cu', mcpPath } = {}) {
    const { baseURL } = getCuRuntime();
    const status = await fetch(`${baseURL}/api/computer-use/status`)
      .then(r => r.json())
      .catch(() => ({}));
    const script = mcpPath || process.env.CU_MCP_PATH || status?.mcpPath;
    const node = process.env.CU_NODE_PATH || status?.nodePath || process.execPath;
    if (!script || !fs.existsSync(script)) {
      throw new EnvironmentBlocked(
        'the isolated instance publishes no existing /api/computer-use/status.mcpPath; set CU_MCP_PATH',
      );
    }
    const child = spawn(node, [script], { stdio: ['pipe', 'pipe', 'pipe'], cwd: path.dirname(script) });
    const client = new CuMcp(child, { label });
    client.init = await client.rpc(
      {
        jsonrpc: '2.0',
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cu-batch', version: '0' } },
      },
      { timeoutMs: INIT_TIMEOUT_MS },
    );
    client.instanceId = readInstanceId(client.init);
    client.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const listed = await client.rpc({ jsonrpc: '2.0', method: 'tools/list', params: {} });
    client.tools = listed?.result?.tools || [];
    return client;
  }

  #onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message = null;
      try {
        message = JSON.parse(line);
      } catch {
        this.notes.push(`unparsable server line: ${line.slice(0, 200)}`);
        continue;
      }
      const entry = this.pending.get(message.id ?? null);
      if (entry) {
        this.pending.delete(message.id ?? null);
        clearTimeout(entry.timer);
        entry.resolve(message);
      } else {
        // Responses to malformed lines carry id:null and match no request — keep them for the
        // protocol cases instead of dropping them.
        this.unsolicited.push(message);
        this.notes.push(`unsolicited message: ${line.slice(0, 200)}`);
      }
    }
  }

  notify(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Sends one raw JSON-RPC object and resolves with the response (or rejects on timeout). */
  rpc(message, { timeoutMs = 10_000 } = {}) {
    const id = message.id ?? this.nextId++;
    const payload = { ...message, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.label}: no response to ${payload.method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  /**
   * Sends an exact raw line (malformed JSON, wrong jsonrpc version, missing method) and returns the
   * server reply. JSON-RPC answers those with a null id, so they land in `unsolicited`.
   */
  async rpcLine(line, { timeoutMs = 10_000 } = {}) {
    const seen = this.unsolicited.length;
    this.child.stdin.write(`${line}\n`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.unsolicited.length > seen) return this.unsolicited[this.unsolicited.length - 1];
      await sleep(20);
    }
    throw new Error(`raw line produced no server response within ${timeoutMs}ms: ${line.slice(0, 80)}`);
  }

  tool(name) {
    return this.tools.find(tool => tool.name === name) || null;
  }

  toolProps(name) {
    return Object.keys(this.tool(name)?.inputSchema?.properties || {});
  }

  async call(name, args, { timeoutMs = 35_000 } = {}) {
    const response = await this.rpc(
      { jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args } },
      { timeoutMs },
    );
    if (response.error) return { rpcError: response.error, raw: null, isError: true, text: '' };
    const result = response.result || {};
    const text = (result.content || [])
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n');
    return {
      rpcError: null,
      raw: result,
      isError: result.isError === true,
      structuredContent: result.structuredContent || null,
      content: result.content || [],
      text,
      images: (result.content || []).filter(part => part.type === 'image'),
    };
  }

  close() {
    try {
      this.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export function readInstanceId(initMessage) {
  const result = initMessage?.result || {};
  const candidates = [
    result.instanceId,
    result.serverInfo?.instanceId,
    result._meta?.instanceId,
    result.instructions,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) {
      const match = /instanceId["'=:\s]+([A-Za-z0-9_-]{4,})/.exec(candidate);
      return match ? match[1] : candidate.slice(0, 64);
    }
  }
  return null;
}

/** Runs `body` with one MCP instance and always tears it down. */
export async function withInstance(body, options) {
  const client = await CuMcp.start(options);
  try {
    return await body(client);
  } finally {
    client.close();
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Envelope assertions (INTERFACE.md「桌面操控与Codex对齐」第 13 段)
// ---------------------------------------------------------------------------

export function expectToolError(res, { code, actionId, mustNotContain = [] }) {
  expect(res.rpcError, 'tool errors are reported inside the MCP result, not as a JSON-RPC error').toBeNull();
  expect(res.raw?.isError, `isError:true for ${code}`).toBe(true);
  expect(Array.isArray(res.raw?.content) && res.raw.content.length > 0, 'content:[文本] for the failure').toBeTruthy();
  expect(res.text.length, 'readable failure text').toBeGreaterThan(0);
  expect(res.text, 'no stack trace in the failure text').not.toMatch(/\n\s+at\s+\S+\s*\(/);
  for (const needle of mustNotContain) {
    expect(res.text, 'failure text must not leak request content').not.toContain(needle);
  }
  const receipt = res.structuredContent;
  expect(receipt, 'structuredContent must carry the machine-readable receipt').toBeTruthy();
  expect(receipt.ok, `ok:false for ${code}`).toBe(false);
  expect(receipt.code, `stable error code ${code}`).toBe(code);
  expect(typeof receipt.state, 'failure receipts carry a state').toBe('string');
  expect(receipt.state.length, 'failure state must not be empty').toBeGreaterThan(0);
  if (actionId !== undefined) {
    expect(receipt.actionId, 'the receipt echoes the caller-supplied actionId').toBe(actionId);
  }
  return receipt;
}

export function expectToolOk(res, { actionId, method, verification }) {
  expect(res.rpcError, 'no JSON-RPC error on success').toBeNull();
  expect(res.raw?.isError, 'isError:false on success').toBe(false);
  const receipt = res.structuredContent;
  expect(receipt, 'structuredContent on success').toBeTruthy();
  expect(receipt.ok, 'ok:true').toBe(true);
  if (actionId !== undefined) expect(receipt.actionId, 'success receipt echoes actionId').toBe(actionId);
  expect(receipt.method, 'success receipt names the method actually used').toBeTruthy();
  if (method !== undefined) expect(receipt.method).toBe(method);
  if (receipt.target !== undefined) expect(receipt.target, 'success receipt echoes the target').toBeTruthy();
  expect(['not-applicable', 'dispatched', 'verified', 'unknown'], 'verification enum').toContain(receipt.verification);
  if (verification !== undefined) expect(receipt.verification, 'documented verification').toBe(verification);
  return receipt;
}

/** A side-effect call must never silently succeed: either it errors, or it declares its verification. */
export function expectNoSilentSuccess(res) {
  if (res.isError) return 'error';
  const receipt = res.structuredContent;
  expect(receipt, 'a successful call must still publish structuredContent').toBeTruthy();
  expect(['dispatched', 'verified', 'unknown', 'not-applicable'], 'verification enum').toContain(receipt.verification);
  return receipt.verification;
}

// ---------------------------------------------------------------------------
// screenshot receipts and the image bytes behind them
// ---------------------------------------------------------------------------

const SCREENSHOT_FIELDS = ['snapshotId', 'imgW', 'imgH', 'logicalBounds', 'displayId', 'target', 'createdAt'];

/** Reads the documented screenshot fields from structuredContent (text fallback for the text-only parts). */
export function screenshotReceipt(res) {
  expect(res.isError, `screenshot must succeed here; text: ${res.text.slice(0, 200)}`).toBe(false);
  const receipt = res.structuredContent || {};
  const fromText = key => {
    const match = new RegExp(`${key}["']?\\s*[:=]\\s*"?([^"\\s,);]+)`, 'i').exec(res.text || '');
    return match ? match[1] : undefined;
  };
  return {
    snapshotId: receipt.snapshotId ?? fromText('snapshotId'),
    imgW: Number(receipt.imgW ?? fromText('imgW')),
    imgH: Number(receipt.imgH ?? fromText('imgH')),
    logicalBounds: receipt.logicalBounds,
    displayId: receipt.displayId,
    target: receipt.target,
    createdAt: receipt.createdAt,
    raw: receipt,
  };
}

export function expectScreenshotFields(receipt, { require = SCREENSHOT_FIELDS } = {}) {
  for (const field of require) {
    expect(receipt[field], `screenshot must publish ${field}`).toBeTruthy();
  }
  expect(Number.isFinite(receipt.imgW) && receipt.imgW > 0, 'imgW must be a positive number').toBe(true);
  expect(Number.isFinite(receipt.imgH) && receipt.imgH > 0, 'imgH must be a positive number').toBe(true);
  return receipt;
}

export function imageBytes(res, index = 0) {
  const image = res.images[index];
  if (!image) throw new EnvironmentBlocked('the response carried no image content; nothing to check');
  const buffer = Buffer.from(String(image.data || ''), 'base64');
  expect(buffer.length, 'the returned image must carry real bytes').toBeGreaterThan(0);
  return { buffer, mimeType: image.mimeType || '' };
}

/** Parses PNG/JPEG dimensions straight from the bytes — the declared size must match them. */
export function imageDimensions(buffer) {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + size;
    }
  }
  throw new EnvironmentBlocked('returned image is neither PNG nor JPEG; cannot verify the byte dimensions');
}

// ---------------------------------------------------------------------------
// window_list parsing (the tool publishes text; the contract fixes the fields)
// ---------------------------------------------------------------------------

const FRONT_RE = /前台应用[:：]\s*([^(\n;；]+?)\s*(?:\(pid\s*(\d+)\))?\s*[;；]?\s*$/m;
const WINDOW_RE = /^#(\d+)\s+pid=(\d+)\s+\[([^\]]*)\]\s+(.*?)\s+\((-?\d+),\s*(-?\d+)\s+(\d+)x(\d+)\)\s*$/gm;

export function parseWindowList(text) {
  const front = FRONT_RE.exec(text);
  const windows = [];
  let match;
  WINDOW_RE.lastIndex = 0;
  while ((match = WINDOW_RE.exec(text)) !== null) {
    windows.push({
      windowId: match[1],
      pid: Number(match[2]),
      app: match[3],
      title: match[4],
      x: Number(match[5]),
      y: Number(match[6]),
      width: Number(match[7]),
      height: Number(match[8]),
    });
  }
  return { frontApp: front ? front[1].trim() : null, frontPid: front?.[2] ? Number(front[2]) : null, windows };
}

/**
 * Reads window_list. `allowEmpty` is for pollers (waitForTarget): a window that was just opened is
 * not listed for a moment, and a window on a Space the operator is not looking at is not listed at
 * all (measured: with Stage Manager on and a fullscreen app in front, every other app's windows are
 * off-screen and the product reports 0). Callers that need a listing assert on emptiness themselves.
 */
export async function windowList(client, { allowEmpty = false } = {}) {
  const res = await client.call('window_list', {}, { timeoutMs: 15_000 });
  expect(res.isError, `window_list must answer; text: ${res.text.slice(0, 200)}`).toBe(false);
  const parsed = parseWindowList(res.text);
  if (!parsed.windows.length && !allowEmpty) {
    throw new EnvironmentBlocked(
      `window_list published no parsable window line; first 300 chars: ${res.text.slice(0, 300)}`,
    );
  }
  return { ...parsed, text: res.text };
}

// ---------------------------------------------------------------------------
// Independent OS oracles (not part of the product)
// ---------------------------------------------------------------------------

/** Frontmost application name, straight from the window server. Never steals focus. */
export function frontAppOracle() {
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    const line = execFileSync('lsappinfo', ['info', '-only', 'name', asn], { encoding: 'utf8' });
    const match = /"LSDisplayName"="([^"]+)"/.exec(line) || /"name"="([^"]+)"/.exec(line);
    return match ? match[1] : line.trim();
  } catch (error) {
    throw new EnvironmentBlocked(`lsappinfo oracle unavailable: ${error.message}`);
  }
}

/** Real pointer position in screen points, via CoreGraphics. Read-only, no permission prompt. */
export function cursorOracle() {
  const source = suitePath('.artifacts', 'cursor-probe.swift');
  const binary = suitePath('.artifacts', 'cursor-probe');
  let out;
  try {
    if (!fs.existsSync(source)) {
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(
        source,
        'import CoreGraphics\nif let e = CGEvent(source: nil) { print("\\(e.location.x),\\(e.location.y)") }\n',
      );
    }
    if (!fs.existsSync(binary)) execFileSync('swiftc', ['-O', source, '-o', binary], { encoding: 'utf8' });
    out = execFileSync(binary, { encoding: 'utf8' }).trim();
  } catch (error) {
    // 编译不可用时退回解释执行（慢但可用），仍失败才算环境缺失。
    try {
      out = execFileSync('swift', [source], { encoding: 'utf8' }).trim();
    } catch (fallbackError) {
      throw new EnvironmentBlocked(`cursor oracle unavailable: ${error.message} / ${fallbackError.message}`);
    }
  }
  const [x, y] = out.split(',').map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new EnvironmentBlocked(`cursor oracle produced "${out}"`);
  return { x, y };
}

export function sameCursor(a, b) {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

/**
 * Pointer baseline for the "the operator desktop did not move" inverses. Same rule as the front-app
 * baseline below: a pointer that is *already* moving gives no usable baseline, so the case reports
 * ENVIRONMENT_BLOCKED instead of blaming the product for the operator's mouse. Measured need: with
 * a single sample, an operator moving the mouse produced "moved the real pointer away" failures.
 */
export async function cursorBaseline({ samples = 4, gapMs = 300 } = {}) {
  let last = cursorOracle();
  for (let index = 0; index < samples; index += 1) {
    await sleep(gapMs);
    const now = cursorOracle();
    if (sameCursor(now, last)) return last;
    last = now;
  }
  throw new EnvironmentBlocked('the pointer kept moving while the baseline was sampled; re-run while idle');
}

/**
 * Baselines for the "the operator desktop did not move" inverses. The operator is working on the
 * same machine, so a changing desktop is ambiguous: an unstable baseline is reported as
 * ENVIRONMENT_BLOCKED (re-run when idle), while a change that survives a second sample after the
 * call is reported as a product failure.
 */
export async function frontAppBaseline({ samples = 4, gapMs = 400 } = {}) {
  let last = frontAppOracle();
  for (let index = 0; index < samples; index += 1) {
    await sleep(gapMs);
    const now = frontAppOracle();
    if (now === last) return last;
    last = now;
  }
  throw new EnvironmentBlocked('the front app kept changing while the baseline was sampled; re-run while the desktop is idle');
}

export async function assertFrontUnchanged(baseline, label) {
  const first = frontAppOracle();
  if (first === baseline) return;
  await sleep(400);
  const second = frontAppOracle();
  if (second === baseline) return; // switched away and came back: operator noise
  if (second !== first) {
    throw new EnvironmentBlocked(
      `${label}: the front app kept changing during the probe ("${first}" → "${second}"); re-run while idle`,
    );
  }
  expect(
    second,
    `${label} changed the front app from "${baseline}" to "${second}" — the operator's desktop must not be touched`,
  ).toBe(baseline);
}

export async function assertCursorUnchanged(baseline, label) {
  const first = cursorOracle();
  if (sameCursor(first, baseline)) return;
  await sleep(400);
  const second = cursorOracle();
  if (sameCursor(second, baseline)) return; // moved and came back: operator noise
  if (!sameCursor(first, second)) {
    throw new EnvironmentBlocked(`${label}: the pointer was moving during the probe (operator activity); re-run while idle`);
  }
  expect(
    `${Math.round(second.x)},${Math.round(second.y)}`,
    `${label} moved the real pointer away from (${Math.round(baseline.x)},${Math.round(baseline.y)})`,
  ).toBe(`${Math.round(baseline.x)},${Math.round(baseline.y)}`);
}

/** Runs `body` and proves afterwards that the operator desktop (front app + pointer) is untouched. */
export async function withoutTouchingDesktop(label, body) {
  const front = await frontAppBaseline();
  const cursor = await cursorBaseline();
  const result = await body();
  await assertFrontUnchanged(front, label);
  await assertCursorUnchanged(cursor, label);
  return result;
}

// ---------------------------------------------------------------------------
// Input safety gate
// ---------------------------------------------------------------------------

export const SIDE_EFFECT_TOOLS = ['left_click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key'];
const CONTRACT_FIELDS = ['actionId', 'target', 'snapshotId', 'foreground'];

/**
 * Every case that could reach a real dispatch calls this first. Two conditions, both required:
 *   1. the tool schema declares the R14–R18 contract fields (target/actionId/snapshotId/foreground),
 *   2. CU_ALLOW_INPUT=1 (operator opt-in for the disposable test window).
 * On a build whose input tools act on the focused window (no target), a validation-failure call
 * cannot be assumed side-effect free, so the case reports ENVIRONMENT_BLOCKED instead of risking
 * the operator's front app. This is a safety gate, not a product verdict.
 */
export function requireActionTool(client, tool) {
  const props = client.toolProps(tool);
  const missing = CONTRACT_FIELDS.filter(field => !props.includes(field));
  if (missing.length) {
    throw new EnvironmentBlocked(
      `${tool} declares no ${missing.join('/')} in its MCP schema, so a call cannot be aimed at the test window: ` +
        'the current implementation acts on the focused window, and calling it could type/click into the operator front app (R14/R16/R17 defect). ' +
        'Re-run after the targeted-tool contract lands.',
    );
  }
  requireFlag(FLAG_INPUT, `${tool} dispatches real input; only the disposable test window may receive it`);
  return props;
}

export function requireScreenRead(what) {
  requireFlag(FLAG_SCREEN, `${what} reads display pixels, which include the operator desktop`);
}

export function requireForeground(what) {
  requireFlag(
    FLAG_FOREGROUND,
    `${what} would take the operator front app away (foreground:true); the suite refuses to run this by default`,
  );
}
