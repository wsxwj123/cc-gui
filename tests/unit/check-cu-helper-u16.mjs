#!/usr/bin/env node
// computer-use 执行层的 UTF-16 码元换算单测(批次3/R16):
//   * u16_units:CGEventKeyboardSetUnicodeString / CGEventKeyboardSetUnicodeString 要的是
//     UTF-16 码元数。传 Python 的 len()(码点数)会把 emoji 拆成半个代理对,事件落到目标
//     文本里就是孤立代理项(R16 的"非BMP字符输入损坏")。
//   * u16_to_cp_offset:AX 的 kAXSelectedTextRange 是 UTF-16 码元偏移,按码点切文本前必须换算,
//     否则文档里有 emoji 时"插入点"会算错位置,verification 跟着错。
// 这两个函数是纯 Python(不 import pyobjc),所以用系统 python3 直接跑,不依赖 cu-runtime venv。
// 跑法:node tests/unit/check-cu-helper-u16.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const helperDir = join(here, '..', '..', 'server', 'computer-use');

const probe = `
import sys
sys.path.insert(0, ${JSON.stringify(helperDir)})
import cu_helper as h
out = []
u16 = h.u16_units
off = h.u16_to_cp_offset

# ③ 回归锚点:emoji 是 2 个 UTF-16 码元,不是 1
out.append(("ascii", u16("a"), 1))
out.append(("emoji", u16("\\U0001F600"), 2))
out.append(("zwj-family", u16("\\U0001F469\\u200D\\U0001F4BB"), 5))
out.append(("cjk", u16("中"), 1))

# ④ 偏移换算:UTF-16 码元 ≥ 码点;边界必须落在合法码点前
out.append(("off-none", off("abc", None), 0))
out.append(("off-zero", off("abc", 0), 0))
out.append(("off-ascii", off("abc", 2), 2))
out.append(("off-emoji-after", off("\\U0001F600x", 2), 1))
out.append(("off-emoji-end", off("\\U0001F600x", 3), 2))
out.append(("off-cut-pair", off("\\U0001F600x", 1), 0))   # 切在代理对中间:只能退到码点边界
out.append(("off-past-end", off("a", 99), 1))

# 每个 UTF-16 边界换算出来的前缀,必须等于按同样码元数编码再解码的前缀
s = "de\\u0301 \\U0001F600 \\u4e2d\\u6587 \\U0001F469\\u200D\\U0001F4BB"
le = s.encode("utf-16-le")
for i in range(0, len(le) // 2 + 1):
    want = le[: i * 2].decode("utf-16-le", "ignore")
    got = s[: off(s, i)]
    assert got == want, ("prefix mismatch at", i, repr(got), repr(want))
out.append(("prefixes", True, True))

for name, got, want in out:
    if got != want:
        print("FAIL", name, "got", repr(got), "want", repr(want))
        sys.exit(1)
print("helper-u16: 全部断言通过 (", len(out), "checks )")
`;

const py = process.env.PYTHON3 || 'python3';
let stdout;
try {
  stdout = execFileSync(py, ['-c', probe], { encoding: 'utf8' });
} catch (error) {
  console.error(String(error.stderr || error.message).slice(0, 800));
  process.exit(1);
}
assert.match(stdout, /全部断言通过/, stdout);
process.stdout.write(stdout);
