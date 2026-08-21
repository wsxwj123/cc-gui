// r26 验收测试共享夹具。红线:样本一律 /tmp 自建;端口只用 6703/6704;绝不碰 6677。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** /tmp 下自建临时 HOME(必须在 import 任何读 homedir 的源码前设置 process.env.HOME)。 */
export function makeTmpHome(tag = 'home') {
  const dir = mkdtempSync(join(tmpdir(), `cgui-r26-${tag}-`));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}

export function makeTmpDir(tag = 'dir') {
  return mkdtempSync(join(tmpdir(), `cgui-r26-${tag}-`));
}

export function cleanupDirs(...dirs) {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
}

/** localStorage 内存 stub(import client 源码前就位)。 */
export function stubLocalStorage(seed = {}) {
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
  return map;
}

/** sessionStore 等 client 模块初始化需要的 window 面 no-op shim。 */
export function stubWindowNoop() {
  globalThis.window = globalThis;
  if (!globalThis.addEventListener) globalThis.addEventListener = () => {};
  if (!globalThis.removeEventListener) globalThis.removeEventListener = () => {};
  if (!globalThis.dispatchEvent) globalThis.dispatchEvent = () => {};
  if (!globalThis.matchMedia) globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}

/** 最小 DOM shim( skins.js 的 loadT2/disposeT2 真跑用;形态对齐 tests/unit/check-skin-t2-chain.mjs )。 */
export function stubDom(initialAttrs = { 'data-theme': 'light' }) {
  const head = { children: [], appendChild(n) { this.children.push(n); n._attached = true; } };
  const de = {
    attrs: { ...initialAttrs },
    getAttributeNames() { return Object.keys(this.attrs); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    style: { setProperty() {}, removeProperty() {} },
  };
  const fakeDocument = {
    head,
    documentElement: de,
    createElement(tag) {
      return {
        tagName: tag, attrs: {}, textContent: '', _attached: false, src: '',
        setAttribute(k, v) { this.attrs[k] = String(v); },
        remove() { this._attached = false; head.children = head.children.filter((x) => x !== this); },
      };
    },
    querySelectorAll(sel) {
      if (sel === '[data-cgui-skin-style]') return head.children.filter((n) => 'data-cgui-skin-style' in n.attrs);
      return [];
    },
  };
  globalThis.document = fakeDocument;
  stubWindowNoop();
  let blobSeq = 0;
  URL.createObjectURL = () => `blob:test-${++blobSeq}`;
  URL.revokeObjectURL = () => {};
  return { head, de, fakeDocument };
}

/** 起 127.0.0.1 临时服务,只允许 6703/6704;EADDRINUSE 退让重试(隔壁 worktree 可能也在跑)。 */
export async function listenWithRetry(port, make, tries = 40) {
  if (![6703, 6704].includes(port)) throw new Error(`测试端口只用 6703/6704(收到 ${port})`);
  for (let i = 0; i < tries; i++) {
    const s = make(port);
    const r = await new Promise((resolve) => {
      s.once('listening', () => resolve({ ok: true }));
      s.once('error', (e) => resolve({ ok: false, err: e }));
    });
    if (r.ok) return s;
    if (r.err?.code !== 'EADDRINUSE') throw r.err;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`端口 ${port} 持续被占用,重试 ${tries} 次后放弃`);
}

/** 关服务:连半开连接一起掐断,否则 close() 永不放手、端口漏给下一个测试。 */
export async function stopServer(server) {
  if (!server) return;
  try { server.closeAllConnections?.(); } catch {}
  server.close();
  await new Promise((r) => server.once('close', r)).catch(() => {});
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
