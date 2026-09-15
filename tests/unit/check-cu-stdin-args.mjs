#!/usr/bin/env node
// computer-use helper 的 --stdin-json 白盒自测(批次8-项1/2):mcp-server 把文本/窗口标题经 stdin 的
// JSON 传给 cu_helper(不进 argv)。Q8 的桩 helper 不读 stdin,这里用真 cu_helper.py 的 main() 验证:
//   * '-' 开头的文本/标题(--dry-run、-zsh)从 stdin 原样到达子命令,argparse 不报错
//   * 没给文本时明确失败(ok:false),不带着 None 去投递
// cmd_* 全换成只回显参数的假函数:不 import Quartz、不碰桌面。
// 跑法:node tests/unit/check-cu-stdin-args.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELPER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'computer-use', 'cu_helper.py');
const PY = existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';
if (process.platform !== 'darwin' || spawnSync(PY, ['-c', 'import json'], { encoding: 'utf8' }).status !== 0) {
  console.log('check-cu-stdin-args: 跳过(computer-use 仅 macOS,且需要 python3)');
  process.exit(0);
}

const SCRIPT = `
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("h", os.environ["CU_HELPER_PATH"])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
for name in dir(m):
    if name.startswith("cmd_"):
        setattr(m, name, lambda a, _n=name: m.out({"ok": True, "cmd": _n, "text": getattr(a, "text", None),
                                                  "title": getattr(a, "title", None), "unicode": getattr(a, "unicode", None)}))
sys.argv = ["cu_helper"] + sys.argv[1:]
m.main()
`;
function run(args, input) {
  const r = spawnSync(PY, ['-c', SCRIPT, ...args], { input, encoding: 'utf8', env: { ...process.env, CU_HELPER_PATH: HELPER } });
  assert.notEqual(r.status, 2, `argparse 拒绝: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

let o = run(['ax-type', '--pid', '1', '--window-id', '2', '--stdin-json'], JSON.stringify({ title: '-zsh', text: '--dry-run' }));
assert.deepEqual([o.ok, o.cmd, o.text, o.title], [true, 'cmd_ax_type', '--dry-run', '-zsh'], 'ax-type 的文本/标题应从 stdin 原样到达');

o = run(['ax-key', '--pid', '1', '--window-id', '2', '--keycode', '0', '--flags', '0', '--stdin-json'], JSON.stringify({ title: '-zsh', unicode: '- item' }));
assert.deepEqual([o.ok, o.cmd, o.unicode, o.title], [true, 'cmd_ax_key', '- item', '-zsh'], 'ax-key 的 unicode/标题应从 stdin 原样到达');

o = run(['ax-state', '--pid', '1', '--window-id', '2', '--stdin-json'], JSON.stringify({ title: 'Login — 标题' }));
assert.equal(o.title, 'Login — 标题', 'ax-state 的标题应从 stdin 到达(含非 ASCII)');

o = run(['type', '--stdin-json', '--fast'], JSON.stringify({ text: '-n 你好 😀' }));
assert.deepEqual([o.ok, o.cmd, o.text], [true, 'cmd_type', '-n 你好 😀'], '前台 type 的文本应从 stdin 原样到达');

o = run(['ax-type', '--pid', '1', '--window-id', '2', '--stdin-json'], '');
assert.equal(o.ok, false, '没给文本必须明确失败,不能带着空值去投递');

o = run(['type', '--stdin-json'], 'not json');
assert.equal(o.ok, false, 'stdin 不是 JSON 必须明确失败');

console.log('check-cu-stdin-args: 全部断言通过 ✓');
