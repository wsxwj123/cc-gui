#!/usr/bin/env python3
"""cc-gui computer-use 执行层(macOS v1)。

设计约定:
- stdout 只输出一行 JSON(协议面);人读诊断一律走 stderr,mcp-server 只信 stdout。
- 重活按需 import:缺某个依赖只废对应子命令,doctor 仍能报告缺什么。
- 坐标系:**逻辑点**(top-left origin,与 Quartz/CGEvent 全局坐标一致)。
  Retina 下截图像素 = 逻辑点 × scaleFactor,换算由 mcp-server 负责(它记录每次
  截图的映射),本层不做换算。
- 【不挡前台】:绝不 activate/raise 任何窗口;目标类操作一律按 pid 定向投递
  (CGEventPostToPid / AX 直写目标元素),全局事件只在调用方显式要求时使用。

定向输入的两条通道(实测结论,2026-09-11 真机):
  1. 事件通道 CGEventPostToPid:文字(CGEventKeyboardSetUnicodeString)、方向键、
     回车、Tab、空格、退格在目标应用**非前台**时仍然生效。
  2. AX 通道:目标窗口的文本框 kAXValue / kAXSelectedText 可读写(用于精确插入
     与读回验证);kAXSelectedTextRange 的**写**被 TextEdit 忽略,不能拿它当
     "设置光标/选择"。app 菜单项(AXPress)与 cmd-组合键在目标非前台时不生效,
     所以 cmd+ 组合键按"投递后读回、读不回就报 unknown"处理,绝不谎称成功。
"""
import argparse
import json
import signal
import subprocess
import sys
import time
from contextlib import contextmanager

# ── 基础 ────────────────────────────────────────────────────────────────

def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()

def die(msg, **extra):
    out({"ok": False, "error": str(msg)[:500], **extra})
    sys.exit(0)

def now_ms():
    return int(time.time() * 1000)

@contextmanager
def up_on_abort(release):
    """按下与抬起之间被打断(超时 SIGTERM → SystemExit,或投递中途异常)时先补发抬起再往外抛,
    不在系统里残留按住的修饰键/鼠标键。正常走完时抬起已由调用方自己发过,这里什么都不做。"""
    try:
        yield
    except BaseException:
        try:
            release()
        except Exception:
            pass
        raise

def _on_sigterm(_signum, _frame):
    # mcp-server 超时先发 SIGTERM:转成 SystemExit,让各层 up_on_abort 补发抬起后退出
    raise SystemExit(143)

# ── 屏幕 ────────────────────────────────────────────────────────────────

def screen_geometry():
    """主显示器:物理像素 + 逻辑点 + scaleFactor。
    screens[0] 恒为带菜单栏的主屏,与 mss 主屏截图同源。"""
    import mss
    with mss.mss() as sct:
        mon = sct.monitors[1]  # monitors[0] 是全体拼接虚拟屏,[1] 才是主屏
        pix_w, pix_h = mon["width"], mon["height"]
        origin = (mon.get("left", 0), mon.get("top", 0))
    logical_w = logical_h = scale = None
    bounds = None
    display_id = None
    try:
        import AppKit
        primary = AppKit.NSScreen.screens()[0]
        f = primary.frame()
        logical_w, logical_h = int(f.size.width), int(f.size.height)
        bounds = {"x": int(f.origin.x), "y": int(f.origin.y), "w": logical_w, "h": logical_h}
        scale = primary.backingScaleFactor()
        try:
            display_id = int(primary.deviceDescription()["NSScreenNumber"])
        except Exception:
            display_id = None
    except Exception as e:
        print(f"NSScreen 不可用:{e}", file=sys.stderr)
    if bounds is None:
        bounds = {"x": origin[0], "y": origin[1], "w": pix_w, "h": pix_h}
    return {"pixel": {"w": pix_w, "h": pix_h},
            "logical": {"w": logical_w, "h": logical_h},
            "bounds": bounds, "displayId": display_id, "scale": scale}

def cmd_screen_info(_a):
    out({"ok": True, **screen_geometry()})

def cmd_screenshot(a):
    import mss, os, re
    mkdir = os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with mss.mss() as sct:
        mon = sct.monitors[1]
        shot = sct.grab(mon)
        mss.tools.to_png(shot.rgb, shot.size, output=a.out)
    geo = screen_geometry()
    png = a.out
    # 4K 原图直接塞给模型既费 token 又可能超 provider 图片上限;用系统 sips 降采样
    # (零 pip 依赖)。max_width<=0 = 保留原始分辨率。坐标契约不变:模型坐标按
    # 【返回的 pixel 尺寸】计,mcp-server 按同一套尺寸映射回逻辑点。
    if a.max_width and geo["pixel"]["w"] > a.max_width:
        subprocess.run(["sips", "-Z", str(a.max_width), png], capture_output=True, timeout=30)
    final = png
    if a.format == "jpeg":
        jpg = a.out[:-4] + ".jpg" if a.out.endswith(".png") else a.out + ".jpg"
        subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "75", png, "--out", jpg],
                       capture_output=True, timeout=30)
        if os.path.exists(jpg):
            final = jpg
    probe = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", final],
                           capture_output=True, text=True, timeout=15)
    w = re.search(r"pixelWidth:\s*(\d+)", probe.stdout)
    h = re.search(r"pixelHeight:\s*(\d+)", probe.stdout)
    if w and h:
        geo["pixel"] = {"w": int(w.group(1)), "h": int(h.group(1))}
    # 临时 PNG 读完即释放(合同:原始临时格式在读完即释放;目录里只留已完成图片)
    if final != png:
        try:
            os.unlink(png)
        except OSError:
            pass
    out({"ok": True, "path": final,
         "mime": "image/jpeg" if a.format == "jpeg" else "image/png", **geo})

# ── 窗口 ────────────────────────────────────────────────────────────────

def bundle_id_of(pid):
    try:
        from AppKit import NSRunningApplication
        app = NSRunningApplication.runningApplicationWithProcessIdentifier_(pid)
        if app is None:
            return None
        return app.bundleIdentifier()
    except Exception:
        return None

def display_for_point(x, y):
    """点落在哪块屏;拿不到就 None(不猜)。"""
    try:
        import Quartz
        r = Quartz.CGGetDisplaysWithPoint((float(x), float(y)), 8, None, None)
        err, ids, count = r if isinstance(r, tuple) and len(r) == 3 else (r, None, None)
        if err == 0 and ids and count:
            return int(ids[0])
    except Exception:
        pass
    return None

def _window_entry(w):
    b = w.get("kCGWindowBounds", {}) or {}
    pid = w.get("kCGWindowOwnerPID")
    bounds = {"x": int(round(b.get("X", 0))), "y": int(round(b.get("Y", 0))),
              "w": int(round(b.get("Width", 0))), "h": int(round(b.get("Height", 0)))}
    return {
        "id": w.get("kCGWindowNumber"),
        "pid": pid,
        "app": w.get("kCGWindowOwnerName", ""),
        "bundleId": bundle_id_of(pid) if pid else None,
        "title": w.get("kCGWindowName", ""),
        "bounds": bounds,
        "displayId": display_for_point(bounds["x"] + bounds["w"] / 2.0, bounds["y"] + bounds["h"] / 2.0),
    }

def list_windows(limit=200):
    import Quartz
    raw = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements,
        Quartz.kCGNullWindowID)
    wins = []
    for w in raw or []:
        if w.get("kCGWindowLayer", 99) != 0:
            continue
        entry = _window_entry(w)
        if not entry["pid"] or entry["bounds"]["w"] <= 0 or entry["bounds"]["h"] <= 0:
            continue
        wins.append(entry)
        if len(wins) >= limit:
            break
    return wins

def frontmost_app():
    try:
        from AppKit import NSWorkspace
        app = NSWorkspace.sharedWorkspace().frontmostApplication()
        return {"pid": app.processIdentifier(), "name": app.localizedName(),
                "bundleId": app.bundleIdentifier()}
    except Exception:
        return None

def cmd_windows(_a):
    out({"ok": True, "frontmost": frontmost_app(), "windows": list_windows()})

def cmd_apps(_a):
    """列出「常规应用」(有 Dock 图标)的身份:bundleId + 系统给的显示名。
    只读进程级的应用身份 —— 等价 Cmd+Tab / Dock 上用户自己一眼可见的那一档:
    不读窗口列表、不读窗口标题、不读几何/像素,也不返回 pid(INTERFACE §B / I3)。
    同一应用多进程实例只出一条(取首次出现的名字),空 bundleId 不列。"""
    from AppKit import NSWorkspace
    names = {}
    for app in NSWorkspace.sharedWorkspace().runningApplications() or []:
        try:
            if app.activationPolicy() != 0:  # NSApplicationActivationPolicyRegular
                continue
            bundle_id = app.bundleIdentifier()
            if not bundle_id or bundle_id in names:
                continue
            names[bundle_id] = app.localizedName() or bundle_id
        except Exception:
            continue  # 单个应用读不到身份不该废掉整份列表
    out({"ok": True, "apps": [{"bundleId": b, "name": names[b]} for b in sorted(names)]})

def cmd_app_info(a):
    """bundleId 是否对应一台已安装的 app(授权判定用它区分"未授权应用"与"不存在的应用")。
    URLForApplicationWithBundleIdentifier 只查 LaunchServices 注册表,不启动应用。"""
    path = None
    try:
        from AppKit import NSWorkspace
        url = NSWorkspace.sharedWorkspace().URLForApplicationWithBundleIdentifier_(a.bundle_id)
        if url is not None:
            path = url.path()
    except Exception as exc:
        out({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return
    name = None
    if path:
        try:
            from AppKit import NSBundle
            b = NSBundle.bundleWithPath_(path)
            if b is not None:
                name = b.objectForInfoDictionaryKey_("CFBundleName") or b.objectForInfoDictionaryKey_("CFBundleDisplayName")
        except Exception:
            name = None
    out({"ok": True, "bundleId": a.bundle_id, "path": path, "name": name, "installed": bool(path)})

# ── AX:目标窗口的文本状态与定向输入 ─────────────────────────────────────

def _ax_trusted():
    try:
        import ApplicationServices
        return bool(ApplicationServices.AXIsProcessTrusted())
    except Exception:
        return None

AX_UNREADABLE = "unreadable"

def ax_window(pid, title, window_id=None):
    """按标题(首选)或 bounds 找目标窗口的 AX 元素。找不到返回 None。
    只看标题不按 bounds:Stage Manager 下 CGWindow 报的是缩略图尺寸而 AX 报真实尺寸,
    bounds 对不上;标题是用户可见身份,也是 target 的实际来源。"""
    import ApplicationServices as AS
    app = AS.AXUIElementCreateApplication(pid)
    err, wins = AS.AXUIElementCopyAttributeValue(app, AS.kAXWindowsAttribute, None)
    if err != 0 or not wins:
        return None
    best = None
    for w in wins:
        e, t = AS.AXUIElementCopyAttributeValue(w, AS.kAXTitleAttribute, None)
        if e != 0:
            continue
        if title is not None and t == title:
            return w
        if best is None:
            best = w
    if window_id is not None:
        # 标题对不上时退化为"该 pid 唯一窗口"的保守匹配,多于一个窗口则不猜
        if len(wins) == 1:
            return wins[0]
        return None
    return best

def ax_find_text(el, depth=0):
    import ApplicationServices as AS
    if depth > 10:
        return None
    e, role = AS.AXUIElementCopyAttributeValue(el, AS.kAXRoleAttribute, None)
    if e == 0 and role in ("AXTextArea", "AXTextField"):
        return el
    e2, kids = AS.AXUIElementCopyAttributeValue(el, AS.kAXChildrenAttribute, None)
    if e2 == 0 and kids:
        for k in kids:
            hit = ax_find_text(k, depth + 1)
            if hit is not None:
                return hit
    return None

def ax_state(pid, title, window_id=None):
    """目标窗口可见文本 + 选择区间;文本元素不存在或不可读返回 {readable: False, reason}。"""
    import ApplicationServices as AS
    if _ax_trusted() is False:
        return {"readable": False, "reason": "permission"}
    win = ax_window(pid, title, window_id)
    if win is None:
        return {"readable": False, "reason": "no-window"}
    tel = ax_find_text(win)
    if tel is None:
        return {"readable": False, "reason": "no-text-element"}
    err, value = AS.AXUIElementCopyAttributeValue(tel, AS.kAXValueAttribute, None)
    if err != 0 or not isinstance(value, str):
        return {"readable": False, "reason": "value-unreadable"}
    start = end = None
    e2, rng = AS.AXUIElementCopyAttributeValue(tel, AS.kAXSelectedTextRangeAttribute, None)
    if e2 == 0 and rng is not None:
        try:
            ok, r = AS.AXValueGetValue(rng, AS.kAXValueCFRangeType, None)
            if ok:
                start, end = int(r[0]), int(r[0]) + int(r[1])
        except Exception:
            start = end = None
    return {"readable": True, "text": value, "selStart": start, "selEnd": end,
            "element": tel, "window": win}

def _public_state(state):
    if not state.get("readable"):
        return {"readable": False, "reason": state.get("reason")}
    return {"readable": True, "text": state["text"], "selStart": state["selStart"], "selEnd": state["selEnd"]}

def cmd_ax_state(a):
    st = ax_state(a.pid, a.title, a.window_id)
    if not st.get("readable"):
        out({"ok": False, "reason": st.get("reason"), "code": "UNREADABLE"})
        return
    out({"ok": True, "state": _public_state(st)})

def u16_units(s):
    """CGEventKeyboardSetUnicodeString 的长度是 UTF-16 码元数,不是 Python 码点数。
    星平面字符(emoji)是 2 个码元:传 len(s)=1 只会投出代理对的前半个,目标文本里
    留下孤立代理项(读回时 json/UTF-8 编码直接炸)。
    ⚠️ 这条对 AX 路径同样成立 —— AX 的 kAXSelectedTextRange 也是 UTF-16 码元偏移。"""
    return len(s.encode("utf-16-le")) // 2

def u16_to_cp_offset(text, offset):
    """UTF-16 码元偏移 → Python 码点下标(用于按码点切片文本)。"""
    if offset is None or offset <= 0:
        return 0
    return len(text.encode("utf-16-le")[:offset * 2].decode("utf-16-le", "ignore"))

def post_unicode_to_pid(pid, text, chunk=20, pause=0.004):
    """把文本作为真实按键事件投给目标进程(尊重目标的插入点/选择)。"""
    import Quartz
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    for i in range(0, len(text), chunk):
        for ch in text[i:i + chunk]:
            for down in (True, False):
                ev = Quartz.CGEventCreateKeyboardEvent(src, 0, down)
                Quartz.CGEventKeyboardSetUnicodeString(ev, u16_units(ch), ch)
                Quartz.CGEventPostToPid(pid, ev)
            time.sleep(pause)
        time.sleep(0.01)

def cmd_ax_type(a):
    """把文本写进目标窗口的文本元素,返回写入前后的状态(上层据此判 verified/unknown)。

    两条通道(实测):
      * 插入点在文末 → AX 直写(等价目标自己的 insertText:,原子、精确、快;长文本也照写)
      * 插入点在中间 → 真实按键事件(实测 AX 直写会落在文末而不认插入点,不能拿它当
        "插在光标处";事件通道尊重插入点)
    两条都不产生全局事件、不动用户前台;读回原文由上层比对。"""
    import ApplicationServices as AS
    text = a.text
    st = ax_state(a.pid, a.title, a.window_id)
    if not st.get("readable"):
        out({"ok": False, "code": "UNREADABLE", "reason": st.get("reason")})
        return
    before = st["text"]
    if st["selStart"] is None or st["selEnd"] is None:
        start = end = len(before)
    else:
        # AX 报的是 UTF-16 码元偏移,Python 按码点切 —— 文档里有 emoji 时不换算会切错位置
        start = u16_to_cp_offset(before, st["selStart"])
        end = u16_to_cp_offset(before, st["selEnd"])
    expected = before[:start] + text + before[end:]
    if text == "":
        # 空串:合同要求"成功且零动作",不写任何东西
        out({"ok": True, "method": "no-op", "before": _public_state(st),
             "after": _public_state(st), "expected": before})
        return
    at_end = start == end == len(before)
    mode = a.mode if a.mode != "auto" else ("value" if at_end else "events")
    if mode == "events":
        post_unicode_to_pid(a.pid, text)
        time.sleep(max(0.15, 20 * len(text) / 1000.0 if len(text) < 500 else 0.3))
        after = ax_state(a.pid, a.title, a.window_id)
        out({"ok": True, "method": "events", "before": _public_state(st),
             "after": _public_state(after), "expected": expected})
        return
    tel = st["element"]
    err = None
    try:
        err = AS.AXUIElementSetAttributeValue(tel, AS.kAXSelectedTextAttribute, text)
    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}"
    time.sleep(0.12)
    after = ax_state(a.pid, a.title, a.window_id)
    method = "selected-text"
    if err != 0 or not after.get("readable") or after["text"] != expected:
        # 退路:整段值写入(仍是目标自己的文本存储,不是我们替它写文件)
        method = "value"
        try:
            AS.AXUIElementSetAttributeValue(tel, AS.kAXValueAttribute, expected)
        except Exception as exc:
            out({"ok": False, "code": "AX_WRITE_FAILED", "error": str(exc)[:300],
                 "before": _public_state(st), "after": _public_state(after),
                 "expected": expected, "insert_err": str(err)[:200]})
            return
        time.sleep(0.12)
        after = ax_state(a.pid, a.title, a.window_id)
    out({"ok": True, "method": method, "before": _public_state(st),
         "after": _public_state(after), "expected": expected,
         "insert_err": None if err == 0 else str(err)[:200]})

def _post_key(pid, keycode=None, flags=0, unicode_char=None):
    import Quartz
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    def post(down):
        ev = Quartz.CGEventCreateKeyboardEvent(src, int(keycode or 0), down)
        if flags:
            Quartz.CGEventSetFlags(ev, int(flags))
        if unicode_char is not None:
            Quartz.CGEventKeyboardSetUnicodeString(ev, u16_units(unicode_char), unicode_char)
        Quartz.CGEventPostToPid(pid, ev)
    with up_on_abort(lambda: post(False)):
        post(True)
        time.sleep(0.008)
        post(False)
    time.sleep(0.008)

FLAG_CMD = 1 << 20          # kCGEventFlagMaskCommand
KEYCODE_A = 0               # 'a'

def needs_select_all(st):
    """cmd+a 期望的终态是"选择区=全文";读不回或空文稿无从判断,返回 False。"""
    if not st.get("readable") or not st["text"]:
        return False
    return not (st.get("selStart") == 0 and st.get("selEnd") == u16_units(st["text"]))

def ax_select_all(st):
    """把目标文本元素的选择区置为全文 —— 目标"全选"命令在 AX 侧的等价物。
    只写目标自己的选择状态,不发任何事件、不动用户前台;生效与否由调用方读回核对。"""
    import ApplicationServices as AS
    tel = st.get("element")
    if tel is None:
        return False
    rng = AS.AXValueCreate(AS.kAXValueCFRangeType, (0, u16_units(st["text"])))
    try:
        return AS.AXUIElementSetAttributeValue(tel, AS.kAXSelectedTextRangeAttribute, rng) == 0
    except Exception:
        return False

def cmd_ax_key(a):
    """定向按键:投递前后各读一次目标文本状态,交给上层判 verified/unknown。"""
    multi = a.unicode is not None and len(a.unicode) > 1
    if multi and (a.keycode or a.flags):
        die("多字符文本不能与 keycode/flags 组合投递")
    st = ax_state(a.pid, a.title, a.window_id)
    before = _public_state(st) if st.get("readable") else {"readable": False, "reason": st.get("reason")}
    if multi:
        # 多字符文本(ax-type 读不回时的回退)逐字符定向投递:单个事件的 unicode 载荷有长度上限,
        # 整段塞进一个事件只会打出开头一小段(与 ax-type events 通道、前台 type 同一做法)
        post_unicode_to_pid(a.pid, a.unicode)
    else:
        _post_key(a.pid, keycode=a.keycode, flags=a.flags, unicode_char=a.unicode)
    time.sleep(max(0.12, a.settle_ms / 1000.0))
    after_st = ax_state(a.pid, a.title, a.window_id)
    # cmd+a(全选)在后台目标上走事件通道不生效 —— macOS 只在应用活动时处理菜单快捷键
    # (实测;AXPress 菜单项同样无效)。这个组合有确定的 AX 等价物,事件没做到时补一次
    # "置选择=全文";其它组合键一个字不动,读回核对仍由上层做,补不上就还是 unknown。
    ax_equivalent = None
    if a.keycode == KEYCODE_A and a.flags == FLAG_CMD and needs_select_all(after_st):
        if ax_select_all(after_st):
            ax_equivalent = "select-all"
            time.sleep(0.05)
            after_st = ax_state(a.pid, a.title, a.window_id)
    after = _public_state(after_st) if after_st.get("readable") else {"readable": False, "reason": after_st.get("reason")}
    out({"ok": True, "before": before, "after": after, "ax_equivalent": ax_equivalent,
         "delivered": {"keycode": a.keycode, "flags": a.flags, "unicode": a.unicode}})

# ── 全局鼠标 / 键盘(仅前台显式授权路径) ────────────────────────────────

MOUSE_BUTTONS = {"left": 0, "right": 1, "middle": 2}

def cg_button_flag(name):
    try:
        import Quartz
        return {"left": Quartz.kCGMouseButtonLeft, "right": Quartz.kCGMouseButtonRight,
                "middle": Quartz.kCGMouseButtonCenter}[name]
    except Exception:
        return None

def background_click(pid, x, y, button, clicks):
    """CGEventPostToPid:事件直接投进目标进程队列 —— 不切前台、不动用户光标。"""
    import Quartz
    btn = cg_button_flag(button)
    down_t = {"left": Quartz.kCGEventLeftMouseDown, "right": Quartz.kCGEventRightMouseDown,
              "middle": Quartz.kCGEventOtherMouseDown}[button]
    up_t = {"left": Quartz.kCGEventLeftMouseUp, "right": Quartz.kCGEventRightMouseUp,
            "middle": Quartz.kCGEventOtherMouseUp}[button]
    for i in range(1, clicks + 1):
        down = Quartz.CGEventCreateMouseEvent(None, down_t, (x, y), btn)
        Quartz.CGEventSetIntegerValueField(down, Quartz.kCGMouseEventClickState, i)
        up = Quartz.CGEventCreateMouseEvent(None, up_t, (x, y), btn)
        Quartz.CGEventSetIntegerValueField(up, Quartz.kCGMouseEventClickState, i)
        with up_on_abort(lambda: Quartz.CGEventPostToPid(pid, up)):
            Quartz.CGEventPostToPid(pid, down)
            Quartz.CGEventPostToPid(pid, up)
        time.sleep(0.06)

def cmd_click(a):
    if a.background_pid:
        background_click(a.background_pid, a.x, a.y, a.button, a.clicks)
        out({"ok": True, "mode": "background-post", "pid": a.background_pid,
             "point": [a.x, a.y], "foreground_affected": False})
        return
    import pyautogui
    pyautogui.FAILSAFE = False
    with up_on_abort(lambda: pyautogui.mouseUp(button=a.button)):
        pyautogui.click(x=a.x, y=a.y, clicks=a.clicks, interval=0.08, button=a.button)
    out({"ok": True, "mode": "global-event", "point": [a.x, a.y], "foreground_affected": True})

def background_drag(pid, x1, y1, x2, y2, steps=8):
    """定向拖拽:down/move…/up 全部 CGEventPostToPid,不切前台、不动用户光标。"""
    import Quartz
    btn = Quartz.kCGMouseButtonLeft
    last = [x1, y1]
    def post(kind, x, y):
        last[:] = [x, y]
        ev = Quartz.CGEventCreateMouseEvent(None, kind, (x, y), btn)
        Quartz.CGEventPostToPid(pid, ev)
    # 中途被打断就在当前拖到的位置松开,不留按住的左键
    with up_on_abort(lambda: post(Quartz.kCGEventLeftMouseUp, *last)):
        post(Quartz.kCGEventLeftMouseDown, x1, y1)
        for i in range(1, steps + 1):
            post(Quartz.kCGEventLeftMouseDragged, round(x1 + (x2 - x1) * i / steps),
                 round(y1 + (y2 - y1) * i / steps))
            time.sleep(0.02)
        post(Quartz.kCGEventLeftMouseUp, x2, y2)

def cmd_drag(a):
    if a.background_pid:
        background_drag(a.background_pid, a.x1, a.y1, a.x2, a.y2)
        out({"ok": True, "mode": "background-post", "pid": a.background_pid,
             "from": [a.x1, a.y1], "to": [a.x2, a.y2], "foreground_affected": False})
        return
    import pyautogui
    pyautogui.FAILSAFE = False
    pyautogui.moveTo(a.x1, a.y1, duration=0.12)
    with up_on_abort(lambda: pyautogui.mouseUp(button="left")):
        pyautogui.mouseDown()
        pyautogui.dragTo(a.x2, a.y2, duration=max(0.2, a.ms / 1000.0), button="left")
        pyautogui.mouseUp()
    out({"ok": True, "mode": "global-event", "from": [a.x1, a.y1], "to": [a.x2, a.y2],
         "foreground_affected": True})

def cmd_scroll(a):
    if a.background_pid:
        # 目标进程定向滚轮:不切前台、不动用户光标
        import Quartz
        src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
        amount = a.amount if a.direction == "up" else -a.amount
        ev = Quartz.CGEventCreateScrollWheelEvent(src, Quartz.kCGScrollEventUnitLine, 1, amount)
        Quartz.CGEventPostToPid(a.background_pid, ev)
        out({"ok": True, "mode": "background-post", "pid": a.background_pid, "point": [a.x, a.y],
             "direction": a.direction, "amount": a.amount, "foreground_affected": False})
        return
    import pyautogui
    pyautogui.FAILSAFE = False
    pyautogui.moveTo(a.x, a.y, duration=0.08)
    amount = a.amount if a.direction == "up" else -a.amount
    pyautogui.scroll(amount)
    out({"ok": True, "mode": "global-event", "point": [a.x, a.y],
         "direction": a.direction, "amount": a.amount, "foreground_affected": True})

def cmd_cursor(a):
    import pyautogui
    x, y = pyautogui.position()
    payload = {"ok": True, "point": [int(x), int(y)]}
    if a.allow_bundle_ids:
        allowed = set(b for b in a.allow_bundle_ids.split(",") if b)
        for w in list_windows():
            if w["bundleId"] not in allowed:
                continue
            b = w["bounds"]
            if b["x"] <= x < b["x"] + b["w"] and b["y"] <= y < b["y"] + b["h"]:
                payload["local"] = {"bundleId": w["bundleId"], "pid": w["pid"],
                                    "windowId": w["id"],
                                    "x": int(x) - b["x"], "y": int(y) - b["y"]}
                break
    out(payload)

def type_text_quartz(text):
    """Unicode 安全输入:CGEventKeyboardSetUnicodeString,中文/emoji 都能打。"""
    import Quartz
    src = Quartz.CGEventSourceCreate(Quartz.kCGEventSourceStateHIDSystemState)
    for i in range(0, len(text), 20):
        for ch in text[i:i + 20]:
            ev = Quartz.CGEventCreateKeyboardEvent(src, 0, True)
            Quartz.CGEventKeyboardSetUnicodeString(ev, u16_units(ch), ch)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev)
            ev2 = Quartz.CGEventCreateKeyboardEvent(src, 0, False)
            Quartz.CGEventKeyboardSetUnicodeString(ev2, u16_units(ch), ch)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, ev2)
            time.sleep(0.006)

def cmd_type(a):
    import pyautogui
    pyautogui.FAILSAFE = False
    text = a.text
    ascii_only = all(ord(c) < 128 for c in text)
    if ascii_only and not a.fast:
        # 大写/符号字符 pyautogui 会先按住 shift:被打断时补一次抬起
        with up_on_abort(lambda: pyautogui.keyUp("shift")):
            pyautogui.typewrite(text, interval=0.012)
    else:
        type_text_quartz(text)
    out({"ok": True, "mode": "global-event", "chars": len(text),
         "method": "typewrite" if ascii_only else "cg-unicode", "foreground_affected": True})

def cmd_key(a):
    """全局按键(前台路径)。"""
    import pyautogui
    pyautogui.FAILSAFE = False
    keys = [k for k in a.keys.split("+") if k]
    if not keys:
        die("空按键序列")
    # hotkey 先逐个按下修饰键再逆序抬起:中途被打断时把本次涉及的键全部抬起,不留按住的 cmd/shift
    with up_on_abort(lambda: [pyautogui.keyUp(k) for k in reversed(keys)]):
        if len(keys) == 1:
            pyautogui.press(keys[0])
        else:
            pyautogui.hotkey(*keys)
    out({"ok": True, "mode": "global-event", "keys": keys, "foreground_affected": True})

# ── doctor(权限自检) ────────────────────────────────────────────────────

def cmd_doctor(_a):
    result = {"ok": True, "platform": sys.platform}
    # 屏幕录制:权限状态查 TCC(CGPreflightScreenCaptureAccess,只查询不弹窗)。
    # 合同明确不能靠"截到一张壁纸/黑图"判截图正常,所以像素抽样只作旁证
    # (capture_test),不进 ok 判定。
    try:
        import Quartz
        allowed = bool(Quartz.CGPreflightScreenCaptureAccess())
        result["screen_recording"] = "ok" if allowed else "denied"
        result["screen_recording_detail"] = None if allowed else "系统设置→隐私与安全性→屏幕与系统音频录制,给终端/CC-GUI 授权"
    except Exception as e:
        result["screen_recording"] = "unknown"
        result["screen_recording_detail"] = f"无法查询屏幕录制权限:{type(e).__name__}: {e}"
    try:
        import mss
        with mss.mss() as sct:
            mon = sct.monitors[1]
            shot = sct.grab({"left": mon["left"] + mon["width"] // 2, "top": mon["top"] + mon["height"] // 2,
                             "width": 64, "height": 64})
            distinct = len(set(bytes(shot.rgb[i:i + 3]) for i in range(0, len(shot.rgb), 12)))
        result["capture_test"] = "ok" if distinct > 4 else "uniform"
        result["capture_test_detail"] = ("抽样区域颜色单一(可能只是桌面内容单调,不能据此判定权限)"
                                         if distinct <= 4 else None)
    except Exception as e:
        result["capture_test"] = "error"
        result["capture_test_detail"] = f"{type(e).__name__}: {e}"
    # 辅助功能:AXIsProcessTrusted 只查询不弹窗
    trusted = _ax_trusted()
    result["accessibility"] = "ok" if trusted else "denied"
    result["accessibility_detail"] = None if trusted else (
        "系统设置→隐私与安全性→辅助功能,给终端/CC-GUI 授权" if trusted is False else "无法查询 AX 信任状态")
    # 依赖导入
    try:
        import pyautogui  # noqa: F401
        result["pyautogui"] = "ok"
    except Exception as e:
        result["pyautogui"] = "error"
        result["pyautogui_detail"] = str(e)
    result["ok"] = not any(str(v) == "error" for k, v in result.items() if k != "platform")
    out(result)

# ── 入口 ────────────────────────────────────────────────────────────────

def main():
    signal.signal(signal.SIGTERM, _on_sigterm)
    p = argparse.ArgumentParser(prog="cu_helper")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("screen-info").set_defaults(func=cmd_screen_info)
    sp = sub.add_parser("screenshot")
    sp.add_argument("--out", required=True)
    sp.add_argument("--max-width", type=int, default=1600)
    sp.add_argument("--format", choices=["png", "jpeg"], default="jpeg")
    sp.set_defaults(func=cmd_screenshot)

    cur = sub.add_parser("cursor")
    cur.add_argument("--allow-bundle-ids", default="")
    cur.set_defaults(func=cmd_cursor)

    c = sub.add_parser("click")
    c.add_argument("--x", type=int, required=True)
    c.add_argument("--y", type=int, required=True)
    c.add_argument("--button", choices=["left", "right", "middle"], default="left")
    c.add_argument("--clicks", type=int, default=1)
    c.add_argument("--background-pid", type=int, default=0)
    c.set_defaults(func=cmd_click)

    d = sub.add_parser("drag")
    d.add_argument("--x1", type=int, required=True)
    d.add_argument("--y1", type=int, required=True)
    d.add_argument("--x2", type=int, required=True)
    d.add_argument("--y2", type=int, required=True)
    d.add_argument("--ms", type=int, default=300)
    d.add_argument("--background-pid", type=int, default=0)
    d.set_defaults(func=cmd_drag)

    s = sub.add_parser("scroll")
    s.add_argument("--x", type=int, required=True)
    s.add_argument("--y", type=int, required=True)
    s.add_argument("--direction", choices=["up", "down"], default="down")
    s.add_argument("--amount", type=int, default=3)
    s.add_argument("--background-pid", type=int, default=0)
    s.set_defaults(func=cmd_scroll)

    k = sub.add_parser("key")
    k.add_argument("--keys", required=True)
    k.set_defaults(func=cmd_key)

    t = sub.add_parser("type")
    t.add_argument("--text", default=None)
    t.add_argument("--fast", action="store_true")
    t.add_argument("--stdin-json", action="store_true")
    t.set_defaults(func=cmd_type)

    sub.add_parser("windows").set_defaults(func=cmd_windows)

    sub.add_parser("apps").set_defaults(func=cmd_apps)

    ai = sub.add_parser("app-info")
    ai.add_argument("--bundle-id", required=True)
    ai.set_defaults(func=cmd_app_info)

    st = sub.add_parser("ax-state")
    st.add_argument("--pid", type=int, required=True)
    st.add_argument("--title", default=None)
    st.add_argument("--window-id", type=int, default=None)
    st.add_argument("--stdin-json", action="store_true")
    st.set_defaults(func=cmd_ax_state)

    at = sub.add_parser("ax-type")
    at.add_argument("--pid", type=int, required=True)
    at.add_argument("--title", default=None)
    at.add_argument("--window-id", type=int, default=None)
    at.add_argument("--text", default=None)
    at.add_argument("--stdin-json", action="store_true")
    at.add_argument("--mode", choices=["auto", "events", "value"], default="auto")
    at.set_defaults(func=cmd_ax_type)

    ak = sub.add_parser("ax-key")
    ak.add_argument("--pid", type=int, required=True)
    ak.add_argument("--title", default=None)
    ak.add_argument("--window-id", type=int, default=None)
    ak.add_argument("--keycode", type=int, default=None)
    ak.add_argument("--flags", type=int, default=0)
    ak.add_argument("--unicode", default=None)
    ak.add_argument("--settle-ms", type=int, default=120)
    ak.add_argument("--stdin-json", action="store_true")
    ak.set_defaults(func=cmd_ax_key)

    sub.add_parser("doctor").set_defaults(func=cmd_doctor)

    a = p.parse_args()
    if getattr(a, "stdin_json", False):
        # 文本/窗口标题经 stdin 的 JSON 传入,不进 argv:进程表全机可读(ps 能看到明文),
        # 且 '-' 开头的值(--dry-run、-zsh)在 argv 里会被 argparse 当成选项
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except ValueError as e:
            die(f"stdin JSON 无法解析: {e}")
        if not isinstance(payload, dict):
            die("stdin JSON 必须是对象")
        for key in ("text", "title", "unicode"):
            if key in payload and hasattr(a, key):
                setattr(a, key, payload[key])
    if a.cmd in ("type", "ax-type") and not isinstance(a.text, str):
        die("缺少要输入的文本(--stdin-json 的 text 字段)")
    try:
        a.func(a)
    except Exception as e:
        die(f"{type(e).__name__}: {e}")

if __name__ == "__main__":
    main()
