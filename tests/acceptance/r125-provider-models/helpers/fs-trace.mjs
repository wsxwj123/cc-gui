// r125 · 探路用预载:记录隔离实例访问过的、路径匹配 R125_FS_TRACE_MATCH 的文件(默认匹配 cc-switch / .db / sqlite),
// 以及起过的子进程命令、加载过的 sqlite 类模块(含构造时传入的路径)。
// 目的:黑盒地弄清"隔离 HOME 下 cc-switch 数据库这条路径怎么来的"(INTERFACE D3 要把它指向损坏文件),不读产品源码。
// 只记路径与操作名到 R125_FS_TRACE_LOG,不改任何行为。不改产品代码,只作用于测试自己起的进程。
import fs from 'node:fs';
import module from 'node:module';
import childProcess from 'node:child_process';

const logFile = process.env.R125_FS_TRACE_LOG;
const re = new RegExp(process.env.R125_FS_TRACE_MATCH || 'cc-switch|\\.db(?:$|[?#])|sqlite', 'i');
const seen = new Set();
function put(line) {
  if (!logFile || seen.has(line)) return;
  seen.add(line);
  try { fs.appendFileSync(logFile, `${line}\n`); } catch { /* 忽略 */ }
}
function note(op, p) {
  const s = typeof p === 'string' ? p : (p && typeof p === 'object' && typeof p.href === 'string' ? p.href : (Buffer.isBuffer(p) ? p.toString() : null));
  if (!s || !re.test(s) || /node_modules/.test(s)) return;
  put(`${op} ${s}`);
}
const wrap = (obj, name) => {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  obj[name] = function r125Traced(...args) { note(name, args[0]); return orig.apply(this, args); };
};
for (const n of ['existsSync', 'readFileSync', 'openSync', 'statSync', 'lstatSync', 'accessSync', 'readdirSync', 'copyFileSync', 'writeFileSync',
  'open', 'readFile', 'stat', 'lstat', 'access', 'readdir', 'copyFile', 'writeFile']) wrap(fs, n);
for (const n of ['open', 'readFile', 'stat', 'lstat', 'access', 'readdir', 'copyFile', 'writeFile']) wrap(fs.promises, n);
module.syncBuiltinESMExports();

// 子进程:记录命令与前几个参数(sqlite3 CLI 读库就会在这儿露头)
for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
  const orig = childProcess[n];
  if (typeof orig !== 'function') continue;
  childProcess[n] = function r125TracedChild(...args) {
    const cmd = [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].map(String).join(' ');
    if (re.test(cmd) || process.env.R125_FS_TRACE_ALL_CHILD === '1') put(`child_process.${n} ${cmd.slice(0, 300)}`);
    return orig.apply(this, args);
  };
}

// sqlite 类模块(CJS require 路径):记录被加载 + 包一层构造函数记路径
const origLoad = module.Module._load;
module.Module._load = function r125TracedLoad(request, parent, isMain) {
  const out = origLoad.call(this, request, parent, isMain);
  if (/sqlite/i.test(String(request))) {
    put(`require ${request} (from ${parent?.filename || '?'})`);
    const wrapCtor = (Ctor, label) => new Proxy(Ctor, { construct(target, args, newTarget) { put(`${label}.construct ${String(args[0])}`); return Reflect.construct(target, args, newTarget); } });
    if (typeof out === 'function') return wrapCtor(out, request);
    if (out && typeof out === 'object') {
      for (const k of Object.keys(out)) if (typeof out[k] === 'function' && /^[A-Z]/.test(k)) { try { out[k] = wrapCtor(out[k], `${request}.${k}`); } catch { /* 只读 */ } }
    }
  }
  return out;
};
