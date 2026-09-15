#!/usr/bin/env node
// computer-use helper 超时收尾白盒自测(批次8-项4):mcp-server 超时先发 SIGTERM,
// helper 必须在"按下已发、抬起未发"的窗口里补发抬起再退出(不残留按住的修饰键)。
// 真机残留(Q8-04d)测不到;这里用假 Quartz 把 down/up 之间的间隔拉长,确定性地让 SIGTERM 落在中间。
// 跑法:node tests/unit/check-cu-sigterm-release.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'computer-use', 'cu_helper.py');
const PY = existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
if (process.platform !== 'darwin' || spawnSync(PY, ['-c', 'import signal'], { encoding: 'utf8' }).status !== 0) {
  console.log('check-cu-sigterm-release: 跳过(computer-use 仅 macOS,且需要 python3)');
  process.exit(0);
}

const SCRIPT = `
import importlib.util, json, os, signal, sys, time, types
fake = types.ModuleType("Quartz")
fake.kCGEventSourceStateHIDSystemState = 1
fake.CGEventSourceCreate = lambda *_: object()
class Ev:
    def __init__(self, down): self.down = down
fake.CGEventCreateKeyboardEvent = lambda src, keycode, down: Ev(bool(down))
fake.CGEventSetFlags = lambda ev, flags: None
fake.CGEventKeyboardSetUnicodeString = lambda ev, n, s: None
def post(pid, ev):
    sys.stdout.write(json.dumps({"down": ev.down}) + "\\n"); sys.stdout.flush()
fake.CGEventPostToPid = post
sys.modules["Quartz"] = fake
spec = importlib.util.spec_from_file_location("h", os.environ["CU_HELPER_PATH"])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
signal.signal(signal.SIGTERM, m._on_sigterm)
real_sleep = time.sleep
m.time.sleep = lambda s: real_sleep(30)  # down/up 之间的 8ms 拉长成 30s:SIGTERM 必落在中间
m._post_key(4242, keycode=55, flags=1 << 20)  # 左 cmd 键 + cmd 标志
`;

const child = spawn(PY, ['-c', SCRIPT], { env: { ...process.env, CU_HELPER_PATH: HELPER }, stdio: ['ignore', 'pipe', 'pipe'] });
const events = [];
let buf = '';
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const ev = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    events.push(ev);
    if (ev.down === true) child.kill('SIGTERM'); // 按下已发、抬起未发:模拟 mcp-server 超时
  }
});
const guard = setTimeout(() => child.kill('SIGKILL'), 15_000);
const [code, signal] = await new Promise((resolve) => child.on('exit', (c, s) => resolve([c, s])));
clearTimeout(guard);

assert.equal(signal, null, `helper 没接住 SIGTERM(被信号 ${signal} 杀死),stderr=${stderr.slice(-300)}`);
assert.equal(code, 143, `helper 应以 143 收尾退出,实际 ${code},stderr=${stderr.slice(-300)}`);
assert.deepEqual(events, [{ down: true }, { down: false }], '按下之后被 SIGTERM 打断,必须补发一次抬起');
console.log('check-cu-sigterm-release: 全部断言通过 ✓');
