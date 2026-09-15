#!/usr/bin/env python3
"""cu_helper.py 的纯 stdlib 探针(不装任何包、不碰桌面、不投递任何事件)。

用系统 python3 把 cu_helper.py 当模块加载(顶层只 import 了 argparse/json/subprocess/sys/time),
然后:
  argparse <argv...>     只跑它自己的 argparse:把所有 cmd_* 换成空函数后调用 main()。
                         退出码 2 = argparse 拒绝(stderr 有 "expected one argument" 一类)。
  ax-key-unicode <text>  给 sys.modules 塞一个假 Quartz(只记录调用),把 ax_state 换成"读不回",
                         直接调 cmd_ax_key(--unicode <text>),把每个键盘事件携带的 unicode 串打出来。
                         stdout 最后一行 JSON:{"events":[{"down":bool,"u16":n,"s":str}], ...}
"""
import importlib.util
import json
import os
import sys
import types

HELPER = os.environ.get("CU_HELPER_PATH")
if not HELPER or not os.path.exists(HELPER):
    print(json.dumps({"probe_error": "CU_HELPER_PATH 未设置或文件不存在"}))
    sys.exit(3)


def load_helper():
    spec = importlib.util.spec_from_file_location("cu_helper_under_test", HELPER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # __name__ != '__main__' → 不会执行 main()
    return mod


def mode_argparse(argv):
    mod = load_helper()
    for name in dir(mod):
        if name.startswith("cmd_"):
            setattr(mod, name, lambda a, _n=name: mod.out({"ok": True, "probe": "parsed", "cmd": _n}))
    sys.argv = ["cu_helper"] + argv
    mod.main()  # argparse 拒绝时 SystemExit(2)


def mode_ax_key_unicode(text):
    events = []

    class Ev:
        def __init__(self, down):
            self.down = down
            self.s = None

    fake = types.ModuleType("Quartz")
    fake.kCGEventSourceStateHIDSystemState = 1
    fake.CGEventSourceCreate = lambda *_: object()
    fake.CGEventCreateKeyboardEvent = lambda src, keycode, down: Ev(bool(down))
    fake.CGEventSetFlags = lambda ev, flags: None

    def set_unicode(ev, n, s):
        ev.s = s
        events.append({"down": ev.down, "u16": int(n), "s": s})

    fake.CGEventKeyboardSetUnicodeString = set_unicode
    posted = []
    fake.CGEventPostToPid = lambda pid, ev: posted.append({"pid": pid, "down": ev.down, "s": ev.s})
    fake.CGEventPost = lambda tap, ev: posted.append({"tap": tap, "down": ev.down, "s": ev.s})
    sys.modules["Quartz"] = fake

    mod = load_helper()
    mod.time.sleep = lambda *_: None  # 不等待:只看事件形状
    mod.ax_state = lambda *a, **k: {"readable": False, "reason": "no-text-element"}
    a = types.SimpleNamespace(pid=4242, title=None, window_id=None, keycode=None, flags=0, unicode=text, settle_ms=0)
    out_lines = []
    mod.out = lambda obj: out_lines.append(obj)
    try:
        mod.cmd_ax_key(a)
        err = None
    except SystemExit as e:  # die() 走 sys.exit(0)
        err = "SystemExit:%s" % e.code
    except Exception as e:  # noqa: BLE001
        err = "%s: %s" % (type(e).__name__, e)
    print(json.dumps({"events": events, "posted": len(posted), "helper_out": out_lines, "error": err}, ensure_ascii=False))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "argparse":
        mode_argparse(sys.argv[2:])
    elif mode == "ax-key-unicode":
        mode_ax_key_unicode(sys.argv[2])
    else:
        print(json.dumps({"probe_error": "unknown mode"}))
        sys.exit(3)
