#!/usr/bin/env node
// r142-附2 —— Windows 截图的**每像素字节数契约**(0.2.412 审查的致命-1 回归)。
//
// 事故:cu_helper_windows.py 把 mss 的 `shot.rgb`(**3 字节/像素**)喂给了 `Image.frombytes(..., "raw", "BGRX")`
// (**4 字节/像素**的解码器)⇒ 真机上任何一次 screenshot 都抛 ValueError ⇒ 无 snapshotId ⇒ 所有坐标工具
// CU_SCREENSHOT_REQUIRED。本机 43 条 r142 用例全绿也照样漏掉它,因为那些用例跑的是"假解释器"桩。
//
// 所以这条用例**不走桩、不碰 Windows API**:直接 import 真的 `cu_helper_windows.py`(它在非 Windows 上
// 也能 import —— WinDLL 那段在 try/except 里)并调用它的 `_downscale`,用真实 Pillow 走解码/缩放/像素回读。
// 断言两件事:
//   ① 3bpp 缓冲(mss `.rgb` 的真实形态)必须解码成功,尺寸/像素/降采样都对;
//   ② 4bpp 缓冲(BGRA/BGRX 形态)必须**抛 ValueError** —— 把这个坑钉死:将来谁把数据源换成 4bpp 却忘了
//      同步改解码模式(或反过来),这里立刻红,而不是等到真机上截图全废。
//
// 口径说明(为什么这么写、语义没放宽):本文件只新增断言,不改任何既有用例;它测的是"字节数契约",
// 不测 Windows API 行为(那些依旧只能真机,PILLOW 缺失时整个文件明确跳过而不是假装通过)。
//
// 跑法:node tests/unit/check-cu-win-shots-bpp.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeReport } from './q8-helpers/report.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WIN_HELPER = join(ROOT, 'server', 'computer-use', 'cu_helper_windows.py');
const report = makeReport('check-cu-win-shots-bpp');

/** 选一个装了 Pillow 的解释器(本机多个候选;都没有就明确跳过,不假装通过)。 */
function pickPython() {
  const candidates = ['python3', '/opt/homebrew/bin/python3', '/usr/bin/python3',
    join(os.homedir(), '.claude-gui', 'cu-runtime', 'venv', 'bin', 'python3')];
  for (const py of candidates) {
    const r = spawnSync(py, ['-c', 'import PIL, PIL.Image; print(PIL.__version__)'], { encoding: 'utf8' });
    if (r.status === 0) return { py, pillow: String(r.stdout).trim() };
  }
  return null;
}

const chosen = pickPython();
if (!chosen) {
  console.log('check-cu-win-shots-bpp: 跳过(本机没有装了 Pillow 的 python3;这条用例需要真 Pillow 才能验字节契约)');
  process.exit(0);
}

// ── 在真 Python 里 import 真 helper,直接调 _downscale ──────────────────
const PROBE = `
import importlib.util, json, os, sys

spec = importlib.util.spec_from_file_location("cu_win_helper", os.environ["CU_WIN_HELPER"])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

W, H = 8, 4
out = {"pillow": __import__("PIL").__version__}

# ① mss 的 shot.rgb 形态:3 字节/像素(RGBRGB…)
raw3 = bytes([255, 0, 0]) * (W * H)
try:
    img = m._downscale(raw3, W, H, 0)
    out["ok3"] = True
    out["size3"] = list(img.size)
    out["px3"] = list(img.getpixel((0, 0)))
    out["mode3"] = img.mode
    out["down"] = list(m._downscale(raw3, W, H, 4).size)   # max_width=4 ⇒ 8x4 → 4x2
except Exception as exc:
    out["ok3"] = False
    out["err3"] = "%s: %s" % (type(exc).__name__, exc)

# ② 4 字节/像素(BGRA/BGRX)形态:必须**抛**,不许按错字节数静默解
raw4 = bytes([0, 0, 255, 255]) * (W * H)
try:
    m._downscale(raw4, W, H, 0)
    out["err4"] = None
except ValueError:
    out["err4"] = "ValueError"
except Exception as exc:
    out["err4"] = type(exc).__name__

# ③ 字节数不足:同样必须抛
try:
    m._downscale(bytes(10), W, H, 0)
    out["short"] = None
except ValueError:
    out["short"] = "ValueError"
except Exception as exc:
    out["short"] = type(exc).__name__

print(json.dumps(out))
`;

const probe = spawnSync(chosen.py, ['-c', PROBE], {
  encoding: 'utf8',
  env: { ...process.env, CU_WIN_HELPER: WIN_HELPER, PYTHONIOENCODING: 'utf-8' },
  timeout: 60_000,
});
let result = null;
try {
  result = JSON.parse(String(probe.stdout).trim().split('\n').pop() || '{}');
} catch { /* 下面按 result=null 报错 */ }

await report.check('SBP-01', '真 helper 的 _downscale 按 3 字节/像素(mss 的 shot.rgb)解码:尺寸/像素/降采样都对', 'red', () => {
  assert.ok(fs.existsSync(WIN_HELPER), `缺 ${WIN_HELPER}`);
  assert.ok(result, `探针没有输出可解析的 JSON(stdout=${String(probe.stdout).slice(0, 300)} stderr=${String(probe.stderr).slice(0, 300)})`);
  assert.ok(result.ok3 === true,
    `3 字节/像素的 RGB 缓冲被 _downscale 拒绝了 —— 这正是真机上截图必失败的那个 bug:${result.err3}`);
  assert.deepEqual(result.size3, [8, 4], `解码尺寸不对:${JSON.stringify(result.size3)}`);
  assert.equal(result.mode3, 'RGB', `解码模式应为 RGB,实际 ${result.mode3}`);
  assert.deepEqual(result.px3, [255, 0, 0], `像素值不对(说明通道/字节序解错了):${JSON.stringify(result.px3)}`);
  assert.deepEqual(result.down, [4, 2], `max_width 降采样不对:${JSON.stringify(result.down)}`);
});

await report.check('SBP-02', '4 字节/像素(BGRA/BGRX)或字节数不足的缓冲必须抛 ValueError(把字节契约钉死,不许静默解错)', 'red', () => {
  assert.ok(result, '探针没有输出可解析的 JSON(见 SBP-01)');
  assert.equal(result.err4, 'ValueError',
    `4 字节/像素的缓冲没有被拒绝(err4=${result.err4})—— 数据源与解码模式必须成对改,这类不匹配要立刻炸`);
  assert.equal(result.short, 'ValueError', `字节数不足的缓冲没有被拒绝(short=${result.short})`);
});


// ── 第二段探针:用**假 mss / 假 user32** 驱动真 helper 的截图与窗口矩形 ──────────
// 这是本机唯一能覆盖 必修-2(取屏范围=主屏)与 必修-3(全程物理像素)的方式:
// 不给真 Windows API,只把库边界换掉,让 helper 自己的取屏/折算逻辑跑起来。
const PROBE_SCOPE = `
import importlib.util, io, json, os, sys, tempfile, types

# ── 假 mss:monitors[0] = 全体虚拟屏(副屏在主屏左侧 ⇒ 负原点、宽 3840),monitors[1] = 主屏 ──
class FakeShot(object):
    def __init__(self, w, h):
        self.width = w
        self.height = h
        self.rgb = bytes([10, 20, 30]) * (w * h)      # 3 字节/像素,与 shot.rgb 的真实形态一致

class FakeSct(object):
    instances = []
    def __init__(self):
        FakeSct.instances.append(self)
        self.monitors = [
            {"left": -1920, "top": 0, "width": 3840, "height": 1080},
            {"left": 0, "top": 0, "width": 1920, "height": 1080},
        ]
        self.last = None
    def grab(self, monitor):
        self.last = dict(monitor)
        return FakeShot(int(monitor["width"]), int(monitor["height"]))
    def __enter__(self):
        return self
    def __exit__(self, *exc):
        return False

fake_mss = types.ModuleType("mss")
fake_mss.mss = FakeSct
sys.modules["mss"] = fake_mss

spec = importlib.util.spec_from_file_location("cu_win_helper", os.environ["CU_WIN_HELPER"])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

out = {}

# ── 必修-2/致命-1:cmd_screenshot 只抓主屏,且回执字段自洽 ──
tmp = tempfile.mkdtemp()
args = types.SimpleNamespace(out=os.path.join(tmp, "shot.png"), format="jpeg", max_width=800)
buf = io.StringIO()
real_stdout = sys.stdout
sys.stdout = buf
try:
    m.cmd_screenshot(args)
finally:
    sys.stdout = real_stdout
reply = json.loads(buf.getvalue().strip().split("\\n")[-1])
out["reply"] = reply
out["captured"] = FakeSct.instances[-1].last
out["jpg_exists"] = os.path.exists(reply["path"])
with open(reply["path"], "rb") as fh:
    out["jpg_magic"] = list(fh.read(2))

# ── 必修-3:window_rect 必须是物理像素(即使系统缩放是 150% 也不除)──
class FakeRect(object):
    def __init__(self):
        self.left = self.top = self.right = self.bottom = 0
    # ctypes.RECT 是 Structure,byref 后 helper 只写字段;这里模拟同样行为

class FakeUser32(object):
    def GetWindowRect(self, hwnd, ref):
        rect = ref._obj
        rect.left, rect.top, rect.right, rect.bottom = 100, 200, 1300, 900   # 物理像素
        return 1

class Rect(object):
    def __init__(self):
        self.left = self.top = self.right = self.bottom = 0

saved_user32 = m.user32
saved_scale = m.dpi_scale
m.user32 = FakeUser32()
m.dpi_scale = lambda: 1.5        # 150% 缩放:旧实现会把上面的物理值除以 1.5
try:
    rect = Rect()
    class Ref(object):
        _obj = rect
    out["window_rect"] = m.window_rect(1)
finally:
    m.user32 = saved_user32
    m.dpi_scale = saved_scale

# ── screen-info 的坐标系不变量:pixel/logical/bounds 必须同尺寸 ──
buf = io.StringIO()
sys.stdout = buf
try:
    m.cmd_screen_info(None)
finally:
    sys.stdout = real_stdout
info = json.loads(buf.getvalue().strip().split("\\n")[-1])
out["screen_info"] = info

print(json.dumps(out))
`;

const scopeProbe = spawnSync(chosen.py, ['-c', PROBE_SCOPE], {
  encoding: 'utf8',
  env: { ...process.env, CU_WIN_HELPER: WIN_HELPER, PYTHONIOENCODING: 'utf-8' },
  timeout: 60_000,
});
let scope = null;
try { scope = JSON.parse(String(scopeProbe.stdout).trim().split('\n').pop() || '{}'); } catch { /* 下面按 null 报错 */ }
const probeErr = `stdout=${String(scopeProbe.stdout).slice(0, 300)} stderr=${String(scopeProbe.stderr).slice(0, 400)}`;

await report.check('SBP-03', '取屏范围 = 主屏(不是 monitors[0] 的全体虚拟屏),且回执的 bounds/logical/pixel 自洽', 'red', () => {
  assert.ok(scope && scope.reply, `探针没有输出可解析的 JSON(${probeErr})`);
  assert.deepEqual(scope.captured, { left: 0, top: 0, width: 1920, height: 1080 },
    `抓的不是主屏:${JSON.stringify(scope.captured)}(monitors[0] 是 3840 宽的全显示器拼接屏)`);
  assert.deepEqual(scope.reply.bounds, { x: 0, y: 0, w: 1920, h: 1080 },
    `回执 bounds 与主屏不一致:${JSON.stringify(scope.reply.bounds)}`);
  assert.deepEqual(scope.reply.logical, { w: 1920, h: 1080 },
    `logical 必须是"输入坐标系里的被捕获区域尺寸"(Windows = 物理像素):${JSON.stringify(scope.reply.logical)}`);
  assert.deepEqual(scope.reply.pixel, { w: 800, h: 450 }, `max_width=800 的降采样结果不对:${JSON.stringify(scope.reply.pixel)}`);
  assert.equal(scope.jpg_exists, true, `截图文件没落盘:${scope.reply.path}`);
  assert.deepEqual(scope.jpg_magic, [255, 216], `落盘的不是 JPEG(前两字节 ${JSON.stringify(scope.jpg_magic)})`);
});

await report.check('SBP-04', 'window_rect 返回物理像素:系统缩放 150% 也不除(HDR/DPI 两套坐标的根因)', 'red', () => {
  assert.ok(scope && scope.window_rect, `探针没有输出 window_rect(${probeErr})`);
  assert.deepEqual(scope.window_rect, { x: 100, y: 200, w: 1200, h: 700 },
    `window_rect 被 scale 除过(旧实现 /1.5 会得到 67/133/800/467):${JSON.stringify(scope.window_rect)}`);
});

await report.check('SBP-05', 'screen-info 的坐标系不变量:pixel 与 logical 同尺寸、bounds 与它们一致', 'red', () => {
  assert.ok(scope && scope.screen_info, `探针没有输出 screen_info(${probeErr})`);
  const info = scope.screen_info;
  assert.deepEqual(info.pixel, info.logical,
    `pixel 与 logical 必须同坐标系同尺寸(旧实现把 pixel 又乘了一次 scale):${JSON.stringify([info.pixel, info.logical])}`);
  assert.equal(info.bounds.w, info.pixel.w, `bounds.w 与 pixel.w 不一致:${JSON.stringify(info.bounds)}`);
  assert.equal(info.bounds.h, info.pixel.h, `bounds.h 与 pixel.h 不一致:${JSON.stringify(info.bounds)}`);
});

process.exit(report.finish());
