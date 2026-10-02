#!/usr/bin/env node
// r142-附4 —— Windows 完整性级别(UIPI 前置诊断)的 ctypes 签名(0.2.412 审查 必修-4 的回归)。
//
// 事故:`GetSidSubAuthorityCount` 返回的是 **PUCHAR**,而 ctypes 未声明 `restype` 时按 C `int`
// 处理返回值 ⇒ 64 位下指针被截断成 Python int ⇒ 随后 `count[0]` 抛 TypeError 被 `except` 吞成
// `"unknown"`。后果:docs 排错表 / TEST-PLAN A1 / EDR 段依赖的 `integrity_level` 永远是死的,
// 而 `doctor` 还把它写成 `available`。这条路径需要 advapi32,本机跑不了真 API —— 但**契约可以测**:
//
// 用一个"行为像 ctypes"的假 advapi32:没声明 restype 就返回 int(模拟指针被截断),声明了才返回
// 可解引用的"指针"。于是:
//   INT-01:声明齐了 ⇒ `integrity_level()` 按 SID 的最后一个子授权值给出 low/medium/high/system;
//   INT-02(负向对照):把两个 GetSid* 的 restype 抹掉 ⇒ 必须退回 "unknown"
//           —— 证明这条断言真的能抓住"签名没声明"这个回归,而不是在复读源码。
//
// 口径说明(为什么这么写、语义没放宽):新增断言只覆盖"签名 → 返回值 → 级别映射"这条链,
// 不改任何既有用例;真机判据(R-W6:普通权限必须报 medium、提权报 high)仍在真机清单里。
//
// 跑法:node tests/unit/check-cu-win-integrity-ctypes.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WIN_HELPER = join(ROOT, 'server', 'computer-use', 'cu_helper_windows.py');
const report = makeReport('check-cu-win-integrity-ctypes');

const PY = fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';

const PROBE = `
import ctypes, ctypes.wintypes, importlib.util, json, os

spec = importlib.util.spec_from_file_location("cu_win_helper", os.environ["CU_WIN_HELPER"])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

# "SID" 与"子授权值"都只是内存块:helper 只读它们的地址与内容
sid_buf = ctypes.create_string_buffer(16)
sid_addr = ctypes.cast(sid_buf, ctypes.c_void_p).value
value_buf = ctypes.c_ulong(int(os.environ["SID_VALUE"], 16))
value_addr = ctypes.cast(ctypes.byref(value_buf), ctypes.c_void_p).value


class Contents(object):
    def __init__(self, value):
        self.value = value


class Ptr(object):
    """声明了 restype 才会拿到的东西:可解引用。"""
    def __init__(self, value):
        self.contents = Contents(value)


class CtypesLikeFunc(object):
    """模拟 ctypes 的**默认**行为:没声明 restype ⇒ 返回值被当成 C int(指针被截断)。"""

    def __init__(self, impl):
        self.restype = None
        self.argtypes = None
        self._impl = impl

    def __call__(self, *args):
        if self.restype is None:
            return 12345            # 截断后的 int:再 .contents 就 AttributeError
        return self._impl(*args)


def _get_token_information(token, cls, buf, size, ref):
    if not buf:
        ref._obj.value = 16         # 第一次调用:只问需要多大
        return 1
    ctypes.memmove(buf, ctypes.byref(ctypes.c_void_p(sid_addr)), ctypes.sizeof(ctypes.c_void_p))
    return 1


class FakeAdvapi(object):
    def __init__(self):
        self.OpenProcessToken = CtypesLikeFunc(lambda *a: 1)
        self.GetTokenInformation = CtypesLikeFunc(_get_token_information)
        self.GetSidSubAuthorityCount = CtypesLikeFunc(lambda sid: Ptr(2))
        self.GetSidSubAuthority = CtypesLikeFunc(lambda sid, idx: Ptr(int(os.environ["SID_VALUE"], 16)))


class FakeKernel(object):
    def __init__(self):
        self.GetCurrentProcess = CtypesLikeFunc(lambda *a: 1)
        self.CloseHandle = lambda h: 1


def _install():
    m.advapi32 = FakeAdvapi()
    m.kernel32 = FakeKernel()
    m._ADVAPI_DECLARED["done"] = False


out = {}
_install()
m._declare_advapi_signatures()
out["with_signatures"] = m.integrity_level()
out["count_restype_declared"] = m.advapi32.GetSidSubAuthorityCount.restype is not None
out["subauth_restype_declared"] = m.advapi32.GetSidSubAuthority.restype is not None

# 负向对照:抹掉声明 ⇒ 必须退回 unknown(等价于旧实现)
m.advapi32.GetSidSubAuthorityCount.restype = None
m.advapi32.GetSidSubAuthority.restype = None
out["without_signatures"] = m.integrity_level()
print(json.dumps(out))
`;

function runProbe(sidValue) {
  const r = spawnSync(PY, ['-c', PROBE], {
    encoding: 'utf8',
    env: { ...process.env, CU_WIN_HELPER: WIN_HELPER, SID_VALUE: sidValue, PYTHONIOENCODING: 'utf-8' },
    timeout: 60_000,
  });
  try { return { out: JSON.parse(String(r.stdout).trim().split('\n').pop() || '{}'), raw: r }; } catch { return { out: null, raw: r }; }
}

const medium = runProbe('0x2000');
const high = runProbe('0x3000');

await report.check('INT-01', 'GetSid* 的 restype 已声明:integrity_level 按 SID 子授权值给出 medium / high(不是 unknown)', 'red', () => {
  assert.ok(medium.out, `探针没有输出可解析的 JSON(stdout=${String(medium.raw.stdout).slice(0, 300)} stderr=${String(medium.raw.stderr).slice(0, 400)})`);
  assert.equal(medium.out.count_restype_declared, true,
    'GetSidSubAuthorityCount 的 restype 没声明 ⇒ 64 位下指针被截断成 int(0.2.412 审查 必修-4)');
  assert.equal(medium.out.subauth_restype_declared, true, 'GetSidSubAuthority 的 restype 没声明');
  assert.equal(medium.out.with_signatures, 'medium', `0x2000 应报 medium,实际 ${medium.out.with_signatures}`);
  assert.equal(high.out && high.out.with_signatures, 'high', `0x3000 应报 high,实际 ${high.out && high.out.with_signatures}`);
});

await report.check('INT-02', '负向对照:抹掉 restype ⇒ 必须退回 unknown(证明这条断言抓得住"签名没声明"的回归)', 'red', () => {
  assert.ok(medium.out, '探针没有输出可解析的 JSON(见 INT-01)');
  assert.equal(medium.out.without_signatures, 'unknown',
    '没声明 restype 时本该退化成 unknown(旧实现的行为)—— 这里没退化说明假 ctypes 没模拟到,断言失去意义');
});

process.exit(report.finish());
