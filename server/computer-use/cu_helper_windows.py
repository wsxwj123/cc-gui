#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""cc-gui computer use 的 Windows 执行层(子命令 CLI;stdout 只出**单行 JSON**)。

设计口径(与 macOS 的 cu_helper.py 对齐,见 PLAN-r142):

  * 子命令名与 mac 侧**完全一致**,只多两个:uia-probe / release-hold。
    mcp-server 是平台无关的,它按固定子命令名 + 固定字段名解析 stdout 的最后一行 JSON。
  * 输入是**阶梯**:`--method uia`(UI Automation 元素级,真后台、可读回)
    → `--method post`(PostMessage 直投 HWND,只对传统 Win32 有效,**没有可靠的失败信号**)
    → `--method global`(SendInput,会抢前台,**只有调用方显式同意才会被要求走这条路**)。
    阶梯的编排在 Node 侧(mcp-server),本文件只忠实执行被点名的那一级。
  * 按键释放(§3.2 B-2):hold-<pid>.json 是"磁盘凭据"——
    **先落盘再按下,先抬起再清盘**(顺序反了就会在强杀窗口里留下按住的修饰键)。
    另有一个守护线程(层 3):按住期间每 200ms 检查父进程存活 + 30s 硬上限。
  * 依赖:mss(截图)、Pillow(降采样/JPEG)、comtypes(UIA 接口)。
    **不依赖 pywin32**;comtypes 缺失不致命 ⇒ 自动落到"只有消息投递"的档位。
  * Python 3.9 兼容:不用 `X | Y` 注解、不用 match、不用 3.10+ 的 stdlib 新特性。
"""
import argparse
import ctypes
import json
import os
import sys
import threading
import time

# ── 输出编码(cp936 机器上 JSON 会乱码)──────────────────────────────────
# 必须在**任何输出之前**重配:中文 Windows 的控制台默认 cp936,JSON 里的非 ASCII
# (窗口标题、输入文本)一旦以 cp936 写出去,Node 侧就是"helper 输出不可解析"。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover - 老 Python / 被重定向的 stdout
    pass

RUNTIME_DIR = os.path.join(os.path.expanduser("~"), ".claude-gui", "cu-runtime")
# hold-<pid>.json:helper 每次改变"按住状态"就原子写它;父进程死后由 watcher/release-hold 读它补发抬起。
HOLD_FILE = os.path.join(RUNTIME_DIR, "hold-%d.json" % os.getpid())
HOLD_GUARD_MS = 30000          # 层 3 的硬上限:按住超过这个时间一定补发抬起
HOLD_POLL_SEC = 0.2            # 层 3 的轮询周期
# 过期 hold 文件的清理/补发抬起由 cu-hold-watcher.js 在 mcp-server 启动时做(它才是常驻进程;
# 单个 helper 进程只执行一条子命令,在这里做清理既没有时机也没有资格)。

try:
    import ctypes.wintypes
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    shcore = ctypes.WinDLL("shcore", use_last_error=True)
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)   # 完整性级别(UIPI 前置检查)
except Exception:  # pragma: no cover - 本文件只在 Windows 上执行
    user32 = kernel32 = gdi32 = shcore = advapi32 = None


# ── 输出信封 ────────────────────────────────────────────────────────────
def out(payload):
    """成功回执:单行 JSON,ensure_ascii=False(与 mac 侧同款)。"""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def die(code, message, **extra):
    """稳定失败码:Node 侧 helperFailure 认 code(白名单原样透传),不认文案。"""
    body = {"ok": False, "code": code, "error": str(message)}
    body.update(extra)
    out(body)
    sys.exit(1)


def soft(code, message, **extra):
    """失败但**不**让 Node 侧当成 HelperError 抛出的形态(__soft=true)。"""
    body = {"ok": False, "__soft": True, "code": code, "error": str(message)}
    body.update(extra)
    out(body)


def read_stdin_json():
    """--stdin-json:文本/标题只经 stdin 传,绝不进 argv(进程表全机可读)。"""
    try:
        raw = sys.stdin.read()
    except Exception:
        return {}
    if not raw or not raw.strip():
        return {}
    try:
        return json.loads(raw)
    except Exception:
        die("CU_INVALID_ARGUMENT", "stdin 不是合法 JSON(需要 {text|title|unicode} 对象)")


# ── DPI 感知(不设 ⇒ 150% 缩放下坐标全错)───────────────────────────────
_DPI_STATE = {"aware": "unset", "scale": 1.0}


def enable_dpi_awareness():
    """Win10 1703+ 用 PER_MONITOR_AWARE_V2(-4),失败回落 SetProcessDPIAware()。"""
    if user32 is None:
        return
    try:
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            _DPI_STATE["aware"] = "per-monitor-v2"
            return
    except Exception:
        pass
    try:
        if user32.SetProcessDPIAware():
            _DPI_STATE["aware"] = "system"
    except Exception:
        _DPI_STATE["aware"] = "failed"


def dpi_scale():
    """系统缩放因子(1.0 / 1.25 / 1.5 …)。shcore 拿不到就按 96 DPI 折算。"""
    if shcore is None:
        return 1.0
    try:
        factor = ctypes.c_uint(100)
        if shcore.GetScaleFactorForDevice(0, ctypes.byref(factor)) == 0 and factor.value:
            return round(factor.value / 100.0, 4)
    except Exception:
        pass
    try:
        dc = user32.GetDC(0)
        dpi = gdi32.GetDeviceCaps(dc, 88)  # LOGPIXELSX
        user32.ReleaseDC(0, dc)
        if dpi:
            return round(dpi / 96.0, 4)
    except Exception:
        pass
    return 1.0


# ── 虚拟屏与坐标(Windows 全程物理像素)──────────────────────────────────
# main() 开头就设了 DPI 感知 ⇒ GetSystemMetrics / GetWindowRect / mss 三者拿到的都是**物理像素**,
# 是同一个坐标系。mac 侧才有"逻辑点 vs 像素"两套(cu_helper.py 用 NSScreen.frame 取逻辑点、mss
# 取像素,所以才要除以 scale);Windows 上照抄那个除法会让 window_list 的 bounds 比真实值小
# 1/scale(0.2.412 审查 必修-3),模型按 bounds 中心点算出的坐标就会偏。
# 回执语义(与 mac 对齐的字段名,值域说明见 docs/computer-use.md):
#   pixel   = 返回图片的像素尺寸(可能被 max_width 降采样)
#   logical = 被捕获区域在**输入坐标系**里的尺寸(Windows = 物理像素;mac = 逻辑点)
#   bounds  = 被捕获区域的原点与尺寸(与 logical 同坐标系;mapPoint 按它把图片像素折算回去)
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79


SM_CXSCREEN, SM_CYSCREEN = 0, 1


def virtual_screen():
    """物理像素的虚拟屏(所有显示器拼接)原点与尺寸 —— SendInput 归一化用。"""
    if user32 is None:
        return (0, 0, 1920, 1080)
    return (
        user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CYVIRTUALSCREEN),
    )


def cursor_pos():
    if user32 is None:
        return (0, 0)
    pt = ctypes.wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return (int(pt.x), int(pt.y))


def primary_screen():
    """主屏(物理像素):Windows 上主屏的左上角恒为 (0,0),尺寸取 SM_CXSCREEN/SM_CYSCREEN。"""
    if user32 is None:
        return {"left": 0, "top": 0, "width": 1920, "height": 1080}
    return {"left": 0, "top": 0,
            "width": int(user32.GetSystemMetrics(SM_CXSCREEN)),
            "height": int(user32.GetSystemMetrics(SM_CYSCREEN))}


def window_rect(hwnd):
    """窗口矩形,**物理像素**(DPI 感知进程的 GetWindowRect 返回的就是物理像素,不除 scale)。"""
    rect = ctypes.wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    return {
        "x": int(rect.left), "y": int(rect.top),
        "w": int(rect.right - rect.left), "h": int(rect.bottom - rect.top),
    }


def window_pid(hwnd):
    pid = ctypes.c_ulong(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return int(pid.value)


def normalize_app_id(value):
    """Windows 的 exe 路径做**身份比较**时的规范形态:分隔符统一成 `\\` + 全小写。

    本仓 AGENTS.md 的 Windows 口径(路径按 `[/\\]` 切、比较需大小写归一化)。授权表里存的可能是
    手填的 `c:/windows/system32/notepad.exe`,而 `enum_windows` 报的是内核路径
    `C:\\Windows\\System32\\notepad.exe` —— 不归一化就是"授权看着成功、动作永远被拒"(0.2.412 审查 必修-5)。
    """
    text = str(value or "").replace("/", "\\")
    while "\\\\" in text:
        text = text.replace("\\\\", "\\")
    return text.rstrip("\\").lower()


def canonical_path(path):
    """把用户填的路径换回**内核里的真实大小写**(GetLongPathNameW);失败就原样返回。"""
    if user32 is None or not path:
        return path
    try:
        size = user32.GetLongPathNameW(str(path), None, 0)
        if not size:
            return path
        buf = ctypes.create_unicode_buffer(size + 1)
        if not user32.GetLongPathNameW(str(path), buf, size + 1):
            return path
        return buf.value or path
    except Exception:
        return path


def process_image_path(pid):
    """QueryFullProcessImageNameW → exe 绝对路径(Windows 上的"应用身份")。"""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        size = ctypes.c_ulong(1024)
        buf = ctypes.create_unicode_buffer(1024)
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return buf.value
        return None
    finally:
        kernel32.CloseHandle(handle)


def window_title(hwnd):
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 2)
    user32.GetWindowTextW(hwnd, buf, length + 2)
    return buf.value


def is_tool_window(hwnd):
    GWL_EXSTYLE, WS_EX_TOOLWINDOW = -20, 0x00000080
    return bool(user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW)


def enum_windows(include_all=False):
    """可见 + 有标题 + 非工具窗口的顶层窗口(与 mac 侧"常规应用窗口"口径对齐)。"""
    found = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)

    def _cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        title = window_title(hwnd)
        if not title:
            return True
        if not include_all and is_tool_window(hwnd):
            return True
        pid = window_pid(hwnd)
        path = process_image_path(pid)
        rect = window_rect(hwnd)
        if not path or not rect:
            return True
        found.append({
            "id": int(hwnd), "pid": pid, "app": os.path.basename(path), "bundleId": path,
            "title": title, "bounds": rect, "displayId": 1,
        })
        return True

    user32.EnumWindows(WNDENUMPROC(_cb), 0)
    return found


def frontmost_window():
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    pid = window_pid(hwnd)
    path = process_image_path(pid)
    if not path:
        return None
    return {"id": int(hwnd), "pid": pid, "app": os.path.basename(path), "bundleId": path,
            "name": os.path.basename(path), "title": window_title(hwnd)}


# ── 完整性级别(UIPI 前置检查)──────────────────────────────────────────
class SID_AND_ATTRIBUTES(ctypes.Structure):
    _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", ctypes.wintypes.DWORD)]


class TOKEN_MANDATORY_LABEL(ctypes.Structure):
    _fields_ = [("Label", SID_AND_ATTRIBUTES)]


_ADVAPI_DECLARED = {"done": False}


def _declare_advapi_signatures():
    """按 MSDN 显式声明签名。

    0.2.412 审查 必修-4:`GetSidSubAuthorityCount` 返回的是 **PUCHAR**,ctypes 未设 restype 时按
    C int 处理返回值 ⇒ 64 位下指针被截断成 Python int ⇒ 随后 `count[0]` 抛 TypeError 被
    `except` 吞成 `"unknown"`,于是 UIPI/EDR 唯一的前置诊断量永远是 unknown。
    """
    if _ADVAPI_DECLARED["done"] or advapi32 is None:
        return
    advapi32.OpenProcessToken.restype = ctypes.wintypes.BOOL
    advapi32.OpenProcessToken.argtypes = [ctypes.wintypes.HANDLE, ctypes.wintypes.DWORD,
                                          ctypes.POINTER(ctypes.wintypes.HANDLE)]
    advapi32.GetTokenInformation.restype = ctypes.wintypes.BOOL
    advapi32.GetTokenInformation.argtypes = [ctypes.wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                             ctypes.wintypes.DWORD, ctypes.POINTER(ctypes.wintypes.DWORD)]
    advapi32.GetSidSubAuthorityCount.restype = ctypes.POINTER(ctypes.c_ubyte)
    advapi32.GetSidSubAuthorityCount.argtypes = [ctypes.c_void_p]
    advapi32.GetSidSubAuthority.restype = ctypes.POINTER(ctypes.c_ulong)
    advapi32.GetSidSubAuthority.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel32.GetCurrentProcess.restype = ctypes.wintypes.HANDLE
    kernel32.GetCurrentProcess.argtypes = []
    _ADVAPI_DECLARED["done"] = True


def integrity_level():
    """low/medium/high/system —— 目标级别比本进程高时,SendInput 会被 UIPI 静默丢掉。"""
    TOKEN_QUERY, TokenIntegrityLevel = 0x0008, 25
    _declare_advapi_signatures()
    token = ctypes.wintypes.HANDLE()
    if not advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), TOKEN_QUERY, ctypes.byref(token)):
        return "unknown"
    try:
        size = ctypes.c_ulong(0)
        advapi32.GetTokenInformation(token, TokenIntegrityLevel, None, 0, ctypes.byref(size))
        buf = ctypes.create_string_buffer(size.value if size.value else 64)
        if not advapi32.GetTokenInformation(token, TokenIntegrityLevel, buf, size.value, ctypes.byref(size)):
            return "unknown"
        # TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES { Sid, Attributes } } → 取 SID 的最后一个子授权值
        label = ctypes.cast(buf, ctypes.POINTER(TOKEN_MANDATORY_LABEL)).contents
        sid = label.Label.Sid
        if not sid:
            return "unknown"
        count_ptr = advapi32.GetSidSubAuthorityCount(sid)
        if not count_ptr:
            return "unknown"
        count = int(count_ptr.contents.value)
        if count <= 0:
            return "unknown"
        last = advapi32.GetSidSubAuthority(sid, count - 1)
        if not last:
            return "unknown"
        value = int(last.contents.value)
        if value >= 0x4000:
            return "system"
        if value >= 0x3000:
            return "high"
        if value >= 0x2000:
            return "medium"
        return "low"
    except Exception:
        return "unknown"
    finally:
        kernel32.CloseHandle(token)


# ── 截图(mss + Pillow;不用 macOS 那套外部命令行工具,那个会静默失败)──────
# ⚠️ 字节契约:mss 的 `shot.rgb` 是 **3 字节/像素**(RGBRGB…),4 字节/像素的是 `shot.raw`/`.bgra`。
# 这个常量必须与 `Image.frombytes` 的模式成对(3B/px ↔ "RGB",4B/px ↔ "BGRX")。
# 0.2.412 审查 致命-1:这里曾把 3B/px 的 `.rgb` 喂给 "BGRX" ⇒ 真机上每次 screenshot 都抛
# `ValueError: not enough image data` ⇒ 无 snapshotId ⇒ 所有坐标工具 CU_SCREENSHOT_REQUIRED。
SHOT_BYTES_PER_PIXEL = 3


def _primary_monitor(sct):
    """主屏(物理像素坐标)。

    授权文案问的是「允许**主屏**全部可见内容」,所以取屏范围必须只含主屏:
    `sct.monitors[0]` 是**全体拼接虚拟屏**(副屏在主屏左侧时含负坐标、把副屏像素也交给模型),
    0.2.412 审查 必修-2 就是这条越权。判定用"包含虚拟屏原点 (0,0) 的那块屏" —— Windows 上
    主屏左上角恒为 (0,0),不依赖 mss 的枚举顺序。
    """
    monitors = list(getattr(sct, "monitors", []) or [])
    for mon in monitors[1:]:
        left, top = int(mon["left"]), int(mon["top"])
        if left <= 0 < left + int(mon["width"]) and top <= 0 < top + int(mon["height"]):
            return dict(mon)
    if len(monitors) > 1:
        return dict(monitors[1])
    if monitors:
        return dict(monitors[0])
    return dict(primary_screen())


def _grab(region=None):
    import mss
    with mss.mss() as sct:
        if region is None:
            monitor = _primary_monitor(sct)
        else:
            left, top, width, height = region
            monitor = {"left": int(left), "top": int(top), "width": max(1, int(width)), "height": max(1, int(height))}
        shot = sct.grab(monitor)
        return shot, dict(monitor)


def _downscale(raw, width, height, max_width):
    """Pillow 解码 + 降采样。字节数不符**立刻抛**(不许按错字节数静默解)。"""
    try:
        from PIL import Image
    except Exception as exc:
        die("CU_RUNTIME_UNAVAILABLE", "Pillow 不可用:%s" % exc)
    expected = int(width) * int(height) * SHOT_BYTES_PER_PIXEL
    if len(raw) != expected:
        raise ValueError(
            "截图缓冲不是 %d 字节/像素的 RGB(应为 %d 字节,实际 %d):数据源与解码模式必须成对 "
            "(mss 的 shot.rgb = 3B/px 配 'RGB';shot.raw/.bgra = 4B/px 配 'BGRX')"
            % (SHOT_BYTES_PER_PIXEL, expected, len(raw)))
    img = Image.frombytes("RGB", (width, height), raw)
    if max_width and width > max_width:
        ratio = float(max_width) / float(width)
        img = img.resize((int(width * ratio), max(1, int(height * ratio))), Image.LANCZOS)
    return img


def cmd_screen_info(_args):
    """主屏信息(物理像素)。scale 只作报告用:本进程 DPI 感知,坐标与尺寸全程物理像素。"""
    mon = primary_screen()
    vx, vy, vw, vh = virtual_screen()
    out({
        "ok": True,
        "pixel": {"w": mon["width"], "h": mon["height"]},
        "logical": {"w": mon["width"], "h": mon["height"]},   # 同坐标系:输入空间尺寸 = 物理像素
        "scale": dpi_scale() or 1.0,
        "bounds": {"x": mon["left"], "y": mon["top"], "w": mon["width"], "h": mon["height"]},
        "virtual_bounds": {"x": vx, "y": vy, "w": vw, "h": vh},
        "display_id": 1,
    })


def cmd_screenshot(args):
    # 取屏范围 = 主屏(用户被问过的那块屏);`shot.rgb` 是 3 字节/像素,与 _downscale 的 "RGB" 成对。
    shot, monitor = _grab()
    scale = dpi_scale() or 1.0
    img = _downscale(shot.rgb, shot.width, shot.height, args.max_width)
    target = args.out
    if args.format == "jpeg":
        target = os.path.splitext(args.out)[0] + ".jpg"
        try:
            img.save(target, "JPEG", quality=72, optimize=True)
        except Exception as exc:
            die("CU_DISPATCH_FAILED", "截图编码失败:%s" % exc)
        mime = "image/jpeg"
    else:
        try:
            img.save(target, "PNG", optimize=True)
        except Exception as exc:
            die("CU_DISPATCH_FAILED", "截图编码失败:%s" % exc)
        mime = "image/png"
    out({
        "ok": True, "path": target, "mime": mime,
        "pixel": {"w": img.width, "h": img.height},
        "logical": {"w": int(round(monitor["width"])), "h": int(round(monitor["height"]))},
        "bounds": {"x": int(monitor["left"]), "y": int(monitor["top"]),
                   "w": int(round(monitor["width"])), "h": int(round(monitor["height"]))},
        "scale": scale, "displayId": 1,
    })


def cmd_cursor(args):
    allowed = [b for b in (args.allow_bundle_ids or "").split(",") if b]
    allowed_keys = set(normalize_app_id(b) for b in allowed)
    x, y = cursor_pos()
    hwnd = user32.WindowFromPoint(ctypes.wintypes.POINT(x, y)) if user32 else 0
    local = None
    if hwnd:
        pid = window_pid(hwnd)
        path = process_image_path(pid)
        if path and (not allowed_keys or normalize_app_id(path) in allowed_keys):
            pt = ctypes.wintypes.POINT(x, y)
            user32.ScreenToClient(hwnd, ctypes.byref(pt))
            local = {"bundleId": path, "windowId": int(hwnd), "x": int(pt.x), "y": int(pt.y)}
    out({"ok": True, "point": [x, y], "local": local})


def cmd_windows(_args):
    windows = enum_windows()
    front = frontmost_window()
    out({"ok": True, "frontmost": front, "windows": windows})


def cmd_apps(_args):
    by_id = {}
    for win in enum_windows():
        by_id.setdefault(win["bundleId"], {"bundleId": win["bundleId"], "name": win["app"]})
    out({"ok": True, "apps": sorted(by_id.values(), key=lambda a: a["bundleId"])})


def cmd_app_info(args):
    raw = args.bundle_id or ""
    # 存在性判定用原串(Windows 文件系统本就大小写不敏感、正斜杠也合法);返回**内核路径**,
    # 让 GUI 侧可以把规范形态存进授权表(与 enum_windows 报的路径同形)。
    installed = bool(raw) and os.path.exists(raw)
    path = canonical_path(raw) if installed else None
    name = os.path.splitext(os.path.basename(path or raw))[0] if raw else None
    out({"ok": True, "installed": installed, "name": name, "path": path,
         "bundleId": path if installed else raw})


# ── UI Automation(comtypes;缺失不致命)──────────────────────────────────
_UIA_CACHE = {"api": None, "error": None, "comtypes": None}


def uia_api():
    """惰性建 IUIAutomation;失败时把原因留在 _UIA_CACHE['error'](供 uia-probe/doctor 报告)。"""
    if _UIA_CACHE["api"] is not None or _UIA_CACHE["error"] is not None:
        return _UIA_CACHE["api"]
    try:
        import comtypes
        import comtypes.client
        _UIA_CACHE["comtypes"] = getattr(comtypes, "__version__", "unknown")
        comtypes.client.GetModule("UIAutomationCore.dll")
        from comtypes.gen import UIAutomationClient as UIA
        api = comtypes.client.CreateObject(UIA.CUIAutomation, interface=UIA.IUIAutomation)
        _UIA_CACHE["api"] = api
        _UIA_CACHE["UIA"] = UIA
        return api
    except Exception as exc:
        _UIA_CACHE["error"] = "%s: %s" % (type(exc).__name__, exc)
        return None


def uia_element_from_point(x, y):
    api = uia_api()
    if api is None:
        die("CU_UIA_UNAVAILABLE", "UI Automation 不可用(comtypes/UIAutomationCore):%s" % _UIA_CACHE["error"],
            uia=False)
    try:
        import comtypes
        from comtypes.gen import UIAutomationClient as UIA
        pt = comtypes.gen.UIAutomationClient.tagPOINT()
        pt.x, pt.y = int(x), int(y)
        element = api.ElementFromPoint(pt)
        if element is None:
            die("CU_UIA_BLOCKED", "ElementFromPoint 在该坐标没有元素(自绘界面/安全桌面/坐标越界)")
        return element, UIA
    except SystemExit:
        raise
    except Exception as exc:
        die("CU_UIA_BLOCKED", "ElementFromPoint 失败:%s" % exc)


def uia_focused_element(hwnd):
    api = uia_api()
    if api is None:
        die("CU_UIA_UNAVAILABLE", "UI Automation 不可用(comtypes/UIAutomationCore):%s" % _UIA_CACHE["error"],
            uia=False)
    try:
        from comtypes.gen import UIAutomationClient as UIA
        root = api.ElementFromHandle(int(hwnd)) if hwnd else api.GetFocusedElement()
        if root is None:
            die("CU_UIA_BLOCKED", "拿不到窗口元素(hwnd 无效或窗口已关闭)")
        try:
            walker = api.RawViewWalker
            child = walker.GetFirstChildElement(root)
            while child is not None:
                try:
                    if child.CurrentHasKeyboardFocus:
                        return child, UIA
                except Exception:
                    pass
                try:
                    child = walker.GetNextSiblingElement(child)
                except Exception:
                    break
        except Exception:
            pass
        return root, UIA
    except SystemExit:
        raise
    except Exception as exc:
        die("CU_UIA_BLOCKED", "取目标窗口元素失败:%s" % exc)


def _pattern(element, pattern_id):
    try:
        return element.GetCurrentPattern(pattern_id)
    except Exception:
        return None


def uia_invoke(element, UIA):
    """点按钮/菜单/链接:InvokePattern → LegacyIAccessible.DoDefaultAction。"""
    pattern = _pattern(element, UIA.UIA_InvokePatternId)
    if pattern is not None:
        pattern.Invoke()
        return "invoke"
    legacy = _pattern(element, UIA.UIA_LegacyIAccessiblePatternId)
    if legacy is not None:
        legacy.DoDefaultAction()
        return "legacy-default-action"
    die("CU_UIA_BLOCKED", "该元素既不支持 InvokePattern 也不支持 LegacyIAccessible(自绘/静态文本)")


def uia_set_value(element, UIA, text):
    """文本输入:ValuePattern.SetValue —— 直接写值,不经键盘、不经焦点。"""
    pattern = _pattern(element, UIA.UIA_ValuePatternId)
    if pattern is None:
        die("CU_UIA_BLOCKED", "该元素不支持 ValuePattern(没有可写的值)")
    pattern.SetValue(text)
    try:
        return pattern.CurrentValue
    except Exception:
        return None


def uia_read_value(element, UIA):
    pattern = _pattern(element, UIA.UIA_ValuePatternId)
    if pattern is None:
        return None
    try:
        return pattern.CurrentValue
    except Exception:
        return None


def uia_scroll(element, UIA, direction, amount):
    pattern = _pattern(element, UIA.UIA_ScrollPatternId)
    if pattern is None:
        die("CU_UIA_BLOCKED", "该元素不支持 ScrollPattern")
    for _ in range(int(amount)):
        pattern.Scroll(UIA.ScrollAmount_NoAmount,
                       UIA.ScrollAmount_SmallIncrement if direction == "down" else UIA.ScrollAmount_SmallDecrement)
    return "scroll-pattern"


# ── 消息投递(PostMessage;只对传统 Win32 有意义,且没有可靠的失败信号)────
WM_LBUTTONDOWN, WM_LBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP = 0x0201, 0x0202, 0x0204, 0x0205
WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_CHAR, WM_KEYDOWN, WM_KEYUP = 0x0200, 0x020A, 0x0102, 0x0100, 0x0101
MK_LBUTTON, MK_RBUTTON = 0x0001, 0x0002
VK_SHIFT, VK_CONTROL, VK_MENU = 0x10, 0x11, 0x12


def _lparam(x, y):
    return (int(y) << 16) | (int(x) & 0xFFFF)


def screen_to_client(hwnd, x, y):
    pt = ctypes.wintypes.POINT(int(x), int(y))
    user32.ScreenToClient(hwnd, ctypes.byref(pt))
    return int(pt.x), int(pt.y)


def post_click(hwnd, x, y, button, clicks):
    cx, cy = screen_to_client(hwnd, x, y)
    down, up, mk = ((WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON) if button == "right" else (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON))
    for _ in range(int(clicks)):
        user32.PostMessageW(hwnd, down, mk, _lparam(cx, cy))
        user32.PostMessageW(hwnd, up, 0, _lparam(cx, cy))
    return {"ok": True, "method": "post-message", "point": [x, y], "client": [cx, cy]}


def post_text(hwnd, text):
    for ch in text:
        code = ord(ch)
        # 补充平面(emoji)用 WM_CHAR 传 UTF-16 代理对
        if code > 0xFFFF:
            code -= 0x10000
            for unit in (0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF)):
                user32.PostMessageW(hwnd, WM_CHAR, unit, 0)
        else:
            user32.PostMessageW(hwnd, WM_CHAR, code, 0)
    return {"ok": True, "method": "post-message", "chars": len(text)}


def post_key(hwnd, keys, vk_map):
    spec = parse_keys(keys, vk_map)
    mods, vk, char = spec["mods"], spec["vk"], spec["char"]
    for mod in mods:
        user32.PostMessageW(hwnd, WM_KEYDOWN, mod, 0)
    if char is not None and not mods:
        post_text(hwnd, char)
    else:
        user32.PostMessageW(hwnd, WM_KEYDOWN, vk, 0)
        user32.PostMessageW(hwnd, WM_KEYUP, vk, 0)
    for mod in reversed(mods):
        user32.PostMessageW(hwnd, WM_KEYUP, mod, 0)
    return {"ok": True, "method": "post-message", "keys": keys}


def post_scroll(hwnd, x, y, direction, amount):
    delta = 120 * int(amount) * (-1 if direction == "down" else 1)
    # ⚠️ MSDN:WM_MOUSEWHEEL 的 lParam 用的是**屏幕坐标**(与其他鼠标消息相反),
    # 这里不做 ScreenToClient(0.2.412 审查 建议-5)。
    user32.PostMessageW(hwnd, WM_MOUSEWHEEL, (delta << 16) & 0xFFFFFFFF, _lparam(x, y))
    return {"ok": True, "method": "post-message", "direction": direction, "amount": int(amount)}


def post_drag(hwnd, x1, y1, x2, y2):
    cx1, cy1 = screen_to_client(hwnd, x1, y1)
    cx2, cy2 = screen_to_client(hwnd, x2, y2)
    _hold_write(["MOUSE_LEFT"])            # 顺序:先落盘,再按下
    up_sent = False
    try:
        user32.PostMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, _lparam(cx1, cy1))
        steps = 8
        for i in range(1, steps + 1):
            user32.PostMessageW(hwnd, WM_MOUSEMOVE, MK_LBUTTON,
                                _lparam(cx1 + (cx2 - cx1) * i // steps, cy1 + (cy2 - cy1) * i // steps))
            time.sleep(0.01)
        user32.PostMessageW(hwnd, WM_LBUTTONUP, 0, _lparam(cx2, cy2))
        up_sent = True
    finally:
        # ⚠️ 只有"抬起已发出"才清凭据(顺序:先抬起,再清盘)。中途失败时**保留** hold 文件:
        # 那是层 2(watcher)/层 3(守护线程)唯一能知道"还按着什么"的依据(0.2.412 审查 建议-1)。
        if up_sent:
            _hold_clear()
    return {"ok": True, "method": "post-message", "from": [x1, y1], "to": [x2, y2]}


# ── 全局投递(SendInput;只有调用方显式 foreground:true 才会走到)──────────
INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
KEYEVENTF_KEYUP, KEYEVENTF_UNICODE = 0x0002, 0x0004
MOUSEEVENTF_MOVE, MOUSEEVENTF_ABSOLUTE = 0x0001, 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000
MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP = 0x0002, 0x0004
MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP = 0x0008, 0x0010
MOUSEEVENTF_WHEEL = 0x0800
ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", ctypes.wintypes.WORD), ("wScan", ctypes.wintypes.WORD),
                ("dwFlags", ctypes.wintypes.DWORD), ("time", ctypes.wintypes.DWORD),
                ("dwExtraInfo", ULONG_PTR)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", ctypes.wintypes.LONG), ("dy", ctypes.wintypes.LONG),
                ("mouseData", ctypes.wintypes.DWORD), ("dwFlags", ctypes.wintypes.DWORD),
                ("time", ctypes.wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", ctypes.wintypes.DWORD), ("wParamL", ctypes.wintypes.WORD),
                ("wParamH", ctypes.wintypes.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("union",)
    _fields_ = [("type", ctypes.wintypes.DWORD), ("union", _INPUTUNION)]


def _send_inputs(inputs):
    """一次 SendInput 调用投递一批事件(层 1:down…up 打包成一批,内核作为一组处理)。

    返回值 = 实际插入输入队列的事件数。**返回数 < 请求数 = 明确的"被拦/被丢"正信号**
    (UIPI / 安全桌面);返回数相等只证明"入了队列",不证明目标应用消费了它。
    """
    count = len(inputs)
    array = (INPUT * count)(*inputs)
    sent = user32.SendInput(count, ctypes.byref(array), ctypes.sizeof(INPUT))
    if sent != count:
        if not user32.GetForegroundWindow():
            die("CU_DISPATCH_FAILED", "SendInput 只送出 %d/%d 个事件(可能处于安全桌面/锁屏)" % (sent, count))
        die("CU_UIPI_BLOCKED", "SendInput 只送出 %d/%d 个事件:目标窗口的完整性级别高于本进程,输入被 UIPI 拦截" % (sent, count))
    return sent


def _mouse_input(dx, dy, data, flags):
    item = INPUT()
    item.type = INPUT_MOUSE
    item.mi = MOUSEINPUT(dx, dy, data, flags, 0, 0)
    return item


def _key_input(vk, flags):
    item = INPUT()
    item.type = INPUT_KEYBOARD
    item.ki = KEYBDINPUT(vk, 0, flags, 0, 0)
    return item


def _normalized_absolute(x, y):
    """多显示器负坐标:归一化基准必须是**虚拟屏原点**(单屏 bounds 折算会点错屏)。"""
    vx, vy, vw, vh = virtual_screen()
    nx = int(round((x - vx) * 65535.0 / max(1, vw - 1)))
    ny = int(round((y - vy) * 65535.0 / max(1, vh - 1)))
    return max(0, min(65535, nx)), max(0, min(65535, ny))


def global_click(x, y, button, clicks):
    nx, ny = _normalized_absolute(x, y)
    move = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
    down = MOUSEEVENTF_RIGHTDOWN if button == "right" else MOUSEEVENTF_LEFTDOWN
    up = MOUSEEVENTF_RIGHTUP if button == "right" else MOUSEEVENTF_LEFTUP
    events = []
    for _ in range(int(clicks)):
        events.append(_mouse_input(nx, ny, 0, move))
        events.append(_mouse_input(0, 0, 0, down))
        events.append(_mouse_input(0, 0, 0, up))
    _send_inputs(events)   # 层 1:一批送出,不产生"按住窗口"
    return {"ok": True, "method": "global", "foreground_affected": True, "point": [x, y]}


def global_drag(x1, y1, x2, y2):
    nx1, ny1 = _normalized_absolute(x1, y1)
    nx2, ny2 = _normalized_absolute(x2, y2)
    move = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
    _hold_write(["MOUSE_LEFT"])            # 先落盘(拖拽是真正的"按住"动作)
    up_sent = False
    try:
        events = [_mouse_input(nx1, ny1, 0, move), _mouse_input(0, 0, 0, MOUSEEVENTF_LEFTDOWN)]
        _send_inputs(events)
        steps = 12
        for i in range(1, steps + 1):
            events = [_mouse_input(nx1 + (nx2 - nx1) * i // steps, ny1 + (ny2 - ny1) * i // steps, 0, move)]
            _send_inputs(events)
            time.sleep(0.01)
        _send_inputs([_mouse_input(0, 0, 0, MOUSEEVENTF_LEFTUP)])
        up_sent = True
    finally:
        # 中途抛错(UIPI 拦截等)时**不动** hold 文件,交给守护线程/watcher 补发抬起。
        if up_sent:
            _hold_clear()
    return {"ok": True, "method": "global", "foreground_affected": True, "from": [x1, y1], "to": [x2, y2]}


def global_key(keys, vk_map):
    spec = parse_keys(keys, vk_map)
    events = []
    for mod in spec["mods"]:
        events.append(_key_input(mod, 0))
    if spec["char"] is not None and not spec["mods"]:
        for unit in _utf16_units(spec["char"]):
            events.append(_key_input(0, KEYEVENTF_UNICODE))
            events[-1].ki.wScan = unit
            events.append(_key_input(0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
            events[-1].ki.wScan = unit
    else:
        events.append(_key_input(spec["vk"], 0))
        events.append(_key_input(spec["vk"], KEYEVENTF_KEYUP))
    for mod in reversed(spec["mods"]):
        events.append(_key_input(mod, KEYEVENTF_KEYUP))
    _send_inputs(events)   # 层 1:down…up 一次送出
    return {"ok": True, "method": "global", "foreground_affected": True, "keys": keys}


def global_text(text):
    events = []
    for unit in _utf16_units(text):
        down = _key_input(0, KEYEVENTF_UNICODE)
        down.ki.wScan = unit
        up = _key_input(0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
        up.ki.wScan = unit
        events.append(down)
        events.append(up)
    _send_inputs(events)
    return {"ok": True, "method": "global", "foreground_affected": True, "chars": len(text)}


def global_scroll(x, y, direction, amount):
    nx, ny = _normalized_absolute(x, y)
    move = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK
    delta = 120 * int(amount) * (-1 if direction == "down" else 1)
    events = [_mouse_input(nx, ny, 0, move), _mouse_input(0, 0, delta & 0xFFFFFFFF, MOUSEEVENTF_WHEEL)]
    _send_inputs(events)
    return {"ok": True, "method": "global", "foreground_affected": True, "direction": direction, "amount": int(amount)}


def _utf16_units(text):
    raw = text.encode("utf-16-le")
    return [raw[i] | (raw[i + 1] << 8) for i in range(0, len(raw), 2)]


# ── 键解析(VK 表;与 mcp-server 的 WIN_VK 同口径)────────────────────────
VK_TABLE = {
    "return": 0x0D, "enter": 0x0D, "escape": 0x1B, "tab": 0x09, "space": 0x20,
    # 契约:`delete` 与 `backspace` 同义(都是退格,与 macOS 一致,mcp-server 的键表锁死这条)。
    # Windows 上那个标着 Delete 的键是 VK_DELETE(0x2E),单列成 vk_delete / del(0.2.412 审查 建议-3)。
    "backspace": 0x08, "delete": 0x08, "vk_delete": 0x2E, "del": 0x2E,
    "arrow_left": 0x25, "arrow_up": 0x26, "arrow_right": 0x27, "arrow_down": 0x28,
    "shift": VK_SHIFT, "ctrl": VK_CONTROL, "alt": VK_MENU,
}
for _c in "abcdefghijklmnopqrstuvwxyz":
    VK_TABLE[_c] = ord(_c.upper())
for _d in "0123456789":
    VK_TABLE[_d] = ord(_d)
ALIASES = {"up": "arrow_up", "down": "arrow_down", "left": "arrow_left", "right": "arrow_right",
           "esc": "escape", "control": "ctrl", "option": "alt"}
MOD_VK = {"ctrl": VK_CONTROL, "shift": VK_SHIFT, "alt": VK_MENU}


def parse_keys(raw, vk_map=None):
    """整串解析;任何一处不合法都整串拒绝(不产生部分按键)。"""
    vk_map = vk_map or VK_TABLE
    parts = str(raw).split("+")
    if not raw or any(p == "" for p in parts):
        die("CU_UNSUPPORTED_KEY", "空键串或多余的 + :%r" % raw)
    mods = []
    for part in parts[:-1]:
        name = ALIASES.get(part.lower(), part.lower())
        if name not in MOD_VK:
            die("CU_UNSUPPORTED_KEY", "不支持的修饰符 %r(Windows 上只有 ctrl/shift/alt;cmd 是 macOS 专用)" % part)
        if MOD_VK[name] in mods:
            die("CU_UNSUPPORTED_KEY", "重复的修饰符 %r" % part)
        mods.append(MOD_VK[name])
    last = parts[-1]
    key = ALIASES.get(last.lower(), last.lower())
    char = None
    if len(last) == 1 and (last.isalnum()):
        char = last
    if key not in vk_map:
        die("CU_UNSUPPORTED_KEY", "不支持的键 %r" % last)
    if mods:                     # 带修饰符的组合按"真实快捷键"投递,不塞字符
        char = None
    return {"mods": mods, "vk": vk_map[key], "char": char}


# ── hold 文件(层 1/2/3 的磁盘凭据;写入顺序是硬约束)────────────────────
_guard = {"thread": None, "stop": False, "parent": None}


def _hold_write(keys):
    """**先落盘,再按下**。反过来的话,强杀正好落在"down 已发、hold 没写"之间就残留。"""
    try:
        os.makedirs(RUNTIME_DIR, exist_ok=True)
        tmp = HOLD_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"version": 1, "pid": os.getpid(), "keys": list(keys),
                                 "held": list(keys), "at": int(time.time() * 1000)}, ensure_ascii=False))
        os.replace(tmp, HOLD_FILE)
    except Exception:
        pass
    _start_guard()


def _hold_clear():
    """**先抬起,再清盘**(调用方保证抬起已发出)。"""
    _guard["stop"] = True
    try:
        if os.path.exists(HOLD_FILE):
            os.remove(HOLD_FILE)
    except Exception:
        pass


def _parent_alive(handle):
    """持句柄判活:Windows 的 pid 回收很激进,getppid()+OpenProcess 会因 pid 复用假活。"""
    if not handle:
        return True
    WAIT_TIMEOUT = 0x00000102
    return kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT


def _start_guard():
    """层 3:按住期间的后台守护(父进程存活 + 30s 硬上限)。"""
    if _guard["thread"] is not None:
        return
    try:
        PROCESS_SYNCHRONIZE = 0x00100000
        _guard["parent"] = kernel32.OpenProcess(PROCESS_SYNCHRONIZE, False, os.getppid())
    except Exception:
        _guard["parent"] = None
    started = time.time()

    def _loop():
        while not _guard["stop"]:
            time.sleep(HOLD_POLL_SEC)
            if _guard["stop"]:
                return
            dead = not _parent_alive(_guard["parent"])
            overtime = (time.time() - started) * 1000 > HOLD_GUARD_MS
            if dead or overtime:
                try:
                    release_all([])
                finally:
                    try:
                        if os.path.exists(HOLD_FILE):
                            os.remove(HOLD_FILE)
                    except Exception:
                        pass
                    os._exit(0)

    thread = threading.Thread(target=_loop, name="cu-hold-guard", daemon=True)
    _guard["thread"] = thread
    thread.start()


MOUSE_KEY_NAMES = {"MOUSE_LEFT": MOUSEEVENTF_LEFTUP, "MOUSELEFT": MOUSEEVENTF_LEFTUP, "LEFT": MOUSEEVENTF_LEFTUP,
                   "MOUSE_RIGHT": MOUSEEVENTF_RIGHTUP, "MOUSERIGHT": MOUSEEVENTF_RIGHTUP, "RIGHT": MOUSEEVENTF_RIGHTUP}
VK_NAME_ALIASES = {"LWIN": 0x5B, "WIN": 0x5B, "LMETA": 0x5B, "RWIN": 0x5C, "RMETA": 0x5C}


def release_all(extra_keys):
    """补发抬起(用 SendInput,与按下时同一套机制)。

    **给了 keys 就只抬这些键**(hold 文件里记着什么就抬什么):这是为了"抬一个已经死掉的 helper 的键"
    不会顺手把**另一个还活着的 helper** 正按着的鼠标左键松开 —— 拖拽是唯一长时间持有的动作
    (0.2.412 delta 审查 第 3 条)。只有没给 keys 时才退回"标准一组"(ctrl/shift/alt/win + 左右键),
    那是"不知道按了什么"的兜底。
    """
    events = []
    if extra_keys:
        for raw in extra_keys:
            name = str(raw).strip()
            upper = name.upper()
            if upper in MOUSE_KEY_NAMES:
                events.append(_mouse_input(0, 0, 0, MOUSE_KEY_NAMES[upper]))
                continue
            if upper in VK_NAME_ALIASES:
                events.append(_key_input(VK_NAME_ALIASES[upper], KEYEVENTF_KEYUP))
                continue
            try:
                spec = parse_keys(name)
                events.append(_key_input(spec["vk"], KEYEVENTF_KEYUP))
            except SystemExit:
                continue
    else:
        for vk in (VK_CONTROL, VK_SHIFT, VK_MENU, 0x5B, 0x5C):   # ctrl/shift/alt/LWin/RWin
            events.append(_key_input(vk, KEYEVENTF_KEYUP))
        for flags in (MOUSEEVENTF_LEFTUP, MOUSEEVENTF_RIGHTUP):
            events.append(_mouse_input(0, 0, 0, flags))
    if events and user32 is not None:
        try:
            count = len(events)
            array = (INPUT * count)(*events)
            user32.SendInput(count, ctypes.byref(array), ctypes.sizeof(INPUT))
        except Exception:
            pass
    return [k for k in extra_keys]


def cmd_release_hold(args):
    keys = [k for k in (args.keys or "").split(",") if k]
    released = release_all(keys)
    try:
        if os.path.exists(HOLD_FILE):
            os.remove(HOLD_FILE)
    except Exception:
        pass
    out({"ok": True, "released": released})


# ── 输入子命令 ──────────────────────────────────────────────────────────
def _sample_region(x, y):
    """diff 取样区:**相对坐标**给,不夹到 0 —— 副屏在主屏左侧时负坐标是合法的
    (旧版 `max(0, …)` 会把取样区拉到主屏左上角,弱证据指错地方;0.2.412 审查 建议-5)。"""
    return (int(x) - 120, int(y) - 80, 240, 160)


def _screen_diff(x, y, before):
    """截图 diff(**弱证据**):目标被遮挡/最小化时双向误判,只用来写文案,不判失败。"""
    try:
        shot, _monitor = _grab(_sample_region(x, y))
        after = bytes(shot.rgb)
    except Exception:
        return None
    if before is None:
        return None
    if not before or len(before) != len(after):
        return {"observed": "unchanged", "diffRatio": 0}
    step = 4
    total = 0
    changed = 0
    for i in range(0, len(after), step):
        total += 1
        if abs(after[i] - before[i]) > 8:
            changed += 1
    return {"observed": "changed" if changed else "unchanged",
            "diffRatio": round(float(changed) / max(1, total), 4)}


def _grab_around(x, y):
    try:
        shot, _monitor = _grab(_sample_region(x, y))
        return bytes(shot.rgb)
    except Exception:
        return None


def require_win_input():
    """输入注入面的前置:执行层没起来时**明确拒绝**(阶段 A 的稳定码),绝不静默降级成别的通道。"""
    if user32 is None or kernel32 is None:
        die("CU_INPUT_UNSUPPORTED", "Windows 输入执行层不可用(user32/kernel32 未加载);未投递任何动作,也没有改成全局点击")


def _require_method(args):
    method = getattr(args, "method", None)
    if method not in ("uia", "post", "global"):
        die("CU_INVALID_ARGUMENT", "--method 必须是 uia/post/global 之一")


def cmd_click(args):
    require_win_input()
    _require_method(args)
    if args.method == "global":
        out(global_click(args.x, args.y, args.button, args.clicks))
        return
    if args.method == "uia":
        element, UIA = uia_element_from_point(args.x, args.y)
        how = uia_invoke(element, UIA)
        # InvokePattern/DoDefaultAction 的契约就是"执行该元素的默认动作",调用返回即已执行
        # (不像键盘注入那样只是"入了队列"),所以这里可以给 verified。
        out({"ok": True, "method": "uia", "how": how, "verified": True, "point": [args.x, args.y]})
        return
    if not args.hwnd:
        die("CU_BACKGROUND_UNSUPPORTED", "消息投递需要 --hwnd(拿不到可投递的窗口)")
    before = _grab_around(args.x, args.y)
    result = post_click(args.hwnd, args.x, args.y, args.button, args.clicks)
    effect = _screen_diff(args.x, args.y, before)
    if effect:
        result["effect"] = effect
    out(result)


def cmd_drag(args):
    require_win_input()
    _require_method(args)
    if args.method == "global":
        out(global_drag(args.x1, args.y1, args.x2, args.y2))
        return
    if args.method == "uia":
        die("CU_UIA_BLOCKED", "UI Automation 没有拖拽 pattern(阶梯 0 无法完成拖拽)")
    if not args.hwnd:
        die("CU_BACKGROUND_UNSUPPORTED", "消息投递需要 --hwnd(拿不到可投递的窗口)")
    before = _grab_around(args.x1, args.y1)
    result = post_drag(args.hwnd, args.x1, args.y1, args.x2, args.y2)
    effect = _screen_diff(args.x1, args.y1, before)
    if effect:
        result["effect"] = effect
    out(result)


def cmd_scroll(args):
    require_win_input()
    _require_method(args)
    if args.method == "global":
        out(global_scroll(args.x, args.y, args.direction, args.amount))
        return
    if args.method == "uia":
        element, UIA = uia_element_from_point(args.x, args.y)
        how = uia_scroll(element, UIA, args.direction, args.amount)
        out({"ok": True, "method": "uia", "how": how, "verified": True})
        return
    if not args.hwnd:
        die("CU_BACKGROUND_UNSUPPORTED", "消息投递需要 --hwnd(拿不到可投递的窗口)")
    out(post_scroll(args.hwnd, args.x, args.y, args.direction, args.amount))


def cmd_type(args):
    require_win_input()
    _require_method(args)
    payload = read_stdin_json()
    text = payload.get("text")
    if text is None:
        die("CU_INVALID_ARGUMENT", "没给文本(--stdin-json 里需要 text);拒绝带着空值投递")
    if args.method == "global":
        out(global_text(text))
        return
    if args.method == "uia":
        element, UIA = uia_focused_element(args.hwnd)
        after = uia_set_value(element, UIA, text)
        verified = bool(after is not None and text in after)
        out({"ok": True, "method": "uia", "chars": len(text), "verified": verified,
             "after": {"readable": after is not None, "text": after if verified else None}})
        return
    if not args.hwnd:
        die("CU_BACKGROUND_UNSUPPORTED", "消息投递需要 --hwnd(拿不到可投递的窗口)")
    rect = window_rect(args.hwnd) or {"x": 0, "y": 0, "w": 0, "h": 0}
    cx = rect["x"] + rect["w"] // 2
    cy = rect["y"] + rect["h"] // 2
    before = _grab_around(cx, cy)
    result = post_text(args.hwnd, text)
    effect = _screen_diff(cx, cy, before)
    if effect:
        result["effect"] = effect
    out(result)


def cmd_key(args):
    require_win_input()
    _require_method(args)
    if args.method == "global":
        out(global_key(args.keys, VK_TABLE))
        return
    if args.method == "uia":
        die("CU_UIA_BLOCKED", "UI Automation 没有投递组合键的 pattern")
    if not args.hwnd:
        die("CU_BACKGROUND_UNSUPPORTED", "消息投递需要 --hwnd(拿不到可投递的窗口)")
    out(post_key(args.hwnd, args.keys, VK_TABLE))


# ── AX 等价子命令(沿用 mac 的子命令名)─────────────────────────────────
def _ax_element(args):
    if getattr(args, "x", None) is not None and getattr(args, "y", None) is not None:
        return uia_element_from_point(args.x, args.y)
    if getattr(args, "hwnd", None):
        return uia_focused_element(args.hwnd)
    die("CU_AX_UNSUPPORTED", "ax-* 需要 --x/--y 或 --hwnd(mcp-server 走 click/type/key 的阶梯,不走 ax-*)")


def cmd_ax_state(args):
    if uia_api() is None:
        die("CU_AX_UNSUPPORTED", "UI Automation 不可用:%s" % _UIA_CACHE["error"])
    element, UIA = _ax_element(args)
    value = uia_read_value(element, UIA)
    out({"ok": True, "state": {"readable": value is not None, "text": value}})


def cmd_ax_type(args):
    if uia_api() is None:
        die("CU_AX_UNSUPPORTED", "UI Automation 不可用:%s" % _UIA_CACHE["error"])
    payload = read_stdin_json()
    text = payload.get("text")
    if text is None:
        die("CU_INVALID_ARGUMENT", "没给文本(--stdin-json 里需要 text)")
    element, UIA = _ax_element(args)
    after = uia_set_value(element, UIA, text)
    out({"ok": True, "method": "uia", "before": {"readable": False}, "after": {"readable": after is not None, "text": after},
         "expected": text})


def cmd_ax_key(args):
    die("CU_AX_UNSUPPORTED", "Windows 上 ax-key 不做组合键投递(UIA 没有该 pattern);请用 key 子命令的消息投递/全局投递")


# ── doctor / uia-probe ──────────────────────────────────────────────────
def cmd_doctor(_args):
    api = uia_api()
    capture = "ok"
    capture_detail = None
    try:
        shot, _monitor = _grab((0, 0, 64, 64))
        raw = bytes(shot.rgb)
        if not raw or max(raw) == 0:
            capture = "failed"
            capture_detail = "抓到的画面全黑(可能是安全桌面/显示器休眠)"
    except Exception as exc:
        capture = "failed"
        capture_detail = "%s: %s" % (type(exc).__name__, exc)
    out({
        "ok": True,
        "platform": "win32",
        "screen_recording": "ok" if capture == "ok" else "denied",
        "screen_recording_detail": capture_detail,
        # Windows 没有 macOS 的 TCC 模型:辅助功能不是一项系统权限,恒 not-applicable。
        "accessibility": "not-applicable",
        "accessibility_detail": "Windows 没有 TCC 式辅助功能权限;UIA 可用性看 uia 一项",
        "capture_test": capture,
        "capture_test_detail": capture_detail,
        "dpi_awareness": _DPI_STATE["aware"],
        "scale": dpi_scale(),
        "integrity_level": integrity_level(),
        "uia": "available" if api is not None else "unavailable",
        "uia_detail": None if api is not None else _UIA_CACHE["error"],
        "comtypes": _UIA_CACHE["comtypes"],
        "python": sys.version.split()[0],
    })


def cmd_uia_probe(args):
    api = uia_api()
    if api is None:
        out({"ok": False, "uia": False, "code": "CU_UIA_UNAVAILABLE", "comtypes": _UIA_CACHE["comtypes"],
             "error": _UIA_CACHE["error"]})
        return
    if args.x is not None and args.y is not None:
        element, _UIA = uia_element_from_point(args.x, args.y)
        out({"ok": True, "uia": True, "element": True, "comtypes": _UIA_CACHE["comtypes"]})
        return
    if getattr(args, "selftest", False):
        try:
            root = api.GetRootElement()
            name = root.CurrentName
            out({"ok": True, "uia": True, "root": bool(name is not None), "comtypes": _UIA_CACHE["comtypes"]})
        except Exception as exc:
            out({"ok": False, "uia": False, "code": "CU_UIA_UNAVAILABLE", "comtypes": _UIA_CACHE["comtypes"],
                 "error": "GetRootElement 失败:%s" % exc})
        return
    out({"ok": True, "uia": True, "comtypes": _UIA_CACHE["comtypes"]})


# ── CLI ─────────────────────────────────────────────────────────────────
def _add_ax_args(parser):
    parser.add_argument("--x", type=int)
    parser.add_argument("--y", type=int)
    parser.add_argument("--hwnd", type=int)
    parser.add_argument("--pid", type=int)
    parser.add_argument("--window-id", type=int)
    parser.add_argument("--keycode", type=int)
    parser.add_argument("--flags", type=int)
    parser.add_argument("--stdin-json", action="store_true")


def build_parser():
    parser = argparse.ArgumentParser(prog="cu_helper_windows", description="cc-gui computer use 的 Windows 执行层")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("screen-info", help="屏幕像素/逻辑尺寸与缩放").set_defaults(func=cmd_screen_info)
    p = sub.add_parser("screenshot", help="截图(mss + Pillow 降采样)")
    p.add_argument("--out", required=True)
    p.add_argument("--format", default="jpeg", choices=["jpeg", "png"])
    p.add_argument("--max-width", type=int, default=1600)
    p.set_defaults(func=cmd_screenshot)

    p = sub.add_parser("cursor", help="光标位置(+已授权窗口内的局部坐标)")
    p.add_argument("--allow-bundle-ids", default="")
    p.set_defaults(func=cmd_cursor)

    sub.add_parser("windows", help="顶层窗口列表(含 frontmost)").set_defaults(func=cmd_windows)
    sub.add_parser("apps", help="可见顶层窗口的 exe 去重名单").set_defaults(func=cmd_apps)

    p = sub.add_parser("app-info", help="exe 路径是否存在(--bundle-id = exe 路径)")
    p.add_argument("--bundle-id", required=True)
    p.set_defaults(func=cmd_app_info)

    # ⚠️ 三个 ax-* 必须**逐字面量**注册:契约测试(T6-02)从源码里抠子命令清单
    # (正则匹配"注册调用后面紧跟字面量名字"),用循环 + 变量名注册会抠不到 ⇒ 被当成"mac 有、Windows 缺"。
    # 同理:任何**注释**里也不要出现那种带字面量名字的注册写法(会被当成多注册了一个子命令)。
    p = sub.add_parser("ax-state", help="AX 等价物:读目标元素的值(UIA ValuePattern)")
    _add_ax_args(p)
    p.set_defaults(func=cmd_ax_state)

    p = sub.add_parser("ax-type", help="AX 等价物:写目标元素的值(UIA ValuePattern)")
    _add_ax_args(p)
    p.set_defaults(func=cmd_ax_type)

    p = sub.add_parser("ax-key", help="AX 等价物(Windows 上不支持组合键投递,见 key 子命令)")
    _add_ax_args(p)
    p.set_defaults(func=cmd_ax_key)

    p = sub.add_parser("click", help="点击(--method uia|post|global)")
    p.add_argument("--method", required=True)
    p.add_argument("--x", type=int, required=True)
    p.add_argument("--y", type=int, required=True)
    p.add_argument("--button", default="left", choices=["left", "right"])
    p.add_argument("--clicks", type=int, default=1)
    p.add_argument("--hwnd", type=int)
    p.set_defaults(func=cmd_click)

    p = sub.add_parser("drag", help="拖拽")
    p.add_argument("--method", required=True)
    p.add_argument("--x1", type=int, required=True)
    p.add_argument("--y1", type=int, required=True)
    p.add_argument("--x2", type=int, required=True)
    p.add_argument("--y2", type=int, required=True)
    p.add_argument("--hwnd", type=int)
    p.set_defaults(func=cmd_drag)

    p = sub.add_parser("scroll", help="滚轮")
    p.add_argument("--method", required=True)
    p.add_argument("--x", type=int, required=True)
    p.add_argument("--y", type=int, required=True)
    p.add_argument("--direction", default="down", choices=["up", "down"])
    p.add_argument("--amount", type=int, default=3)
    p.add_argument("--hwnd", type=int)
    p.set_defaults(func=cmd_scroll)

    p = sub.add_parser("key", help="按键(组合键走消息投递或全局投递)")
    p.add_argument("--method", required=True)
    p.add_argument("--keys", required=True)
    p.add_argument("--hwnd", type=int)
    p.set_defaults(func=cmd_key)

    p = sub.add_parser("type", help="输入文本(--stdin-json)")
    p.add_argument("--method", required=True)
    p.add_argument("--hwnd", type=int)
    p.add_argument("--stdin-json", action="store_true")
    p.add_argument("--fast", action="store_true", help="大段文本的提速开关(消息投递本身就是逐字符)")
    p.set_defaults(func=cmd_type)

    sub.add_parser("doctor", help="环境自检").set_defaults(func=cmd_doctor)

    p = sub.add_parser("uia-probe", help="UI Automation 可用性探测(只读)")
    p.add_argument("--selftest", action="store_true")
    p.add_argument("--x", type=int)
    p.add_argument("--y", type=int)
    p.add_argument("--hwnd", type=int)
    p.set_defaults(func=cmd_uia_probe)

    p = sub.add_parser("release-hold", help="补发抬起(层 2/4 的释放入口)")
    p.add_argument("--keys", default="")
    p.set_defaults(func=cmd_release_hold)
    return parser


def main(argv=None):
    enable_dpi_awareness()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as exc:  # 兜底:任何未预期异常都变成稳定码,不让 Node 侧只看到堆栈
        die("CU_DISPATCH_FAILED", "%s: %s" % (type(exc).__name__, exc))


if __name__ == "__main__":
    main()
