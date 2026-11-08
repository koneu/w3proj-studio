#!/usr/bin/env python3
"""X11 hands for we-drive.mjs: lists windows, presses keys, clicks, takes pictures, on one display (an Xvfb of
its own), through python-xlib and its XTest extension. Every command prints one JSON line.

  we-x11.py --display :N windows                       mapped top-level windows: id, title, class, rect, pid, transient
  we-x11.py --display :N key KEY [--window ID]         press and release a key ("v", "Escape", "ctrl+s", "alt+F4", "Return")
  we-x11.py --display :N click X,Y [--button 1|3] [--double]   click at a screen position
  we-x11.py --display :N move X,Y                      move the pointer
  we-x11.py --display :N drag X1,Y1 X2,Y2 [--button 1|2|3]  press at one point, move to the other, release
  we-x11.py --display :N shot FILE [--rect X,Y,W,H]    picture of the screen (or a part of it) as PNG
  we-x11.py --display :N focus ID                      give a window the keyboard focus and raise it
  we-x11.py --display :N close ID                      ask a window to close (WM_DELETE_WINDOW)
  we-x11.py --display :N stats [--rect X,Y,W,H]        counts of a part of the screen (see stats())
  we-x11.py --display :N frames MS [--rect X,Y,W,H]    how often a part of the screen changes during MS
  we-x11.py stats FILE [--rect X,Y,W,H]                the same counts of a picture

Run with `python3 -I` (we-drive does) so nothing in the working folder is imported.
"""

import json
import sys

from PIL import Image


def out(obj):
    print(json.dumps(obj))
    sys.stdout.flush()


def parse_rect(s):
    x, y, w, h = (int(v) for v in s.split(","))
    return x, y, w, h


def connect(name):
    from Xlib import display
    return display.Display(name)


def prop(d, w, name, kind=None):
    from Xlib import X
    try:
        p = w.get_full_property(d.intern_atom(name), kind if kind is not None else X.AnyPropertyType)
    except Exception:
        return None
    return p.value if p else None


def title_of(d, w):
    v = prop(d, w, "_NET_WM_NAME", d.intern_atom("UTF8_STRING"))
    if v is not None:
        return v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v)
    try:
        n = w.get_wm_name()
    except Exception:
        n = None
    if isinstance(n, bytes):
        return n.decode("latin-1", "replace")
    return n or ""


def windows(d):
    from Xlib import X
    root = d.screen().root
    names = {}
    for a in ("_NET_WM_WINDOW_TYPE_DIALOG", "_NET_WM_WINDOW_TYPE_NORMAL", "_NET_WM_WINDOW_TYPE_UTILITY",
              "_NET_WM_WINDOW_TYPE_TOOLTIP", "_NET_WM_WINDOW_TYPE_POPUP_MENU", "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU",
              "_NET_WM_WINDOW_TYPE_MENU", "_NET_WM_WINDOW_TYPE_SPLASH", "_NET_WM_STATE_MODAL"):
        names[d.intern_atom(a)] = a.replace("_NET_WM_WINDOW_TYPE_", "").replace("_NET_WM_STATE_", "").lower()
    found = []
    for w in root.query_tree().children:
        try:
            attrs = w.get_attributes()
            if attrs.map_state != X.IsViewable:
                continue
            g = w.get_geometry()
            pos = w.translate_coords(root, 0, 0)
            x, y = -pos.x, -pos.y
            cls = None
            try:
                c = w.get_wm_class()
                cls = c[1] if c else None
            except Exception:
                pass
            types = [names.get(a, str(a)) for a in (prop(d, w, "_NET_WM_WINDOW_TYPE") or [])]
            state = [names.get(a, str(a)) for a in (prop(d, w, "_NET_WM_STATE") or [])]
            pid = prop(d, w, "_NET_WM_PID")
            tr = None
            try:
                t = w.get_wm_transient_for()
                tr = t.id if t else None
            except Exception:
                pass
            found.append({"id": w.id, "title": title_of(d, w), "class": cls, "rect": [x, y, g.width, g.height],
                          "pid": int(pid[0]) if pid else None, "transientFor": tr, "types": types, "state": state,
                          "overrideRedirect": bool(attrs.override_redirect)})
        except Exception:
            continue
    return found


MODS = {"ctrl": "Control_L", "control": "Control_L", "shift": "Shift_L", "alt": "Alt_L", "super": "Super_L"}


def keycode(d, name):
    from Xlib import XK
    sym = XK.string_to_keysym(name)
    if sym == 0 and len(name) == 1:
        sym = ord(name)
    if sym == 0:
        raise SystemExit(f"unknown key {name}")
    code = d.keysym_to_keycode(sym)
    if code == 0:
        raise SystemExit(f"no keycode for {name}")
    return code


def press_key(d, spec):
    from Xlib import X
    from Xlib.ext import xtest
    import time
    parts = spec.split("+")
    mods = [keycode(d, MODS[p.lower()]) for p in parts[:-1]]
    key = keycode(d, parts[-1])
    for m in mods:
        xtest.fake_input(d, X.KeyPress, m)
    d.sync()
    xtest.fake_input(d, X.KeyPress, key)
    d.sync()
    time.sleep(0.05)
    xtest.fake_input(d, X.KeyRelease, key)
    for m in reversed(mods):
        xtest.fake_input(d, X.KeyRelease, m)
    d.sync()


def move(d, x, y):
    from Xlib import X
    from Xlib.ext import xtest
    xtest.fake_input(d, X.MotionNotify, x=x, y=y)
    d.sync()


def click(d, x, y, button=1, double=False):
    from Xlib import X
    from Xlib.ext import xtest
    import time
    move(d, x, y)
    time.sleep(0.05)
    for _ in range(2 if double else 1):
        xtest.fake_input(d, X.ButtonPress, button)
        d.sync()
        time.sleep(0.05)
        xtest.fake_input(d, X.ButtonRelease, button)
        d.sync()
        time.sleep(0.05)


def drag(d, a, b, button=1):
    from Xlib import X
    from Xlib.ext import xtest
    import time
    move(d, *a)
    time.sleep(0.05)
    xtest.fake_input(d, X.ButtonPress, button)
    d.sync()
    steps = 20
    for i in range(1, steps + 1):
        time.sleep(0.02)
        move(d, a[0] + (b[0] - a[0]) * i // steps, a[1] + (b[1] - a[1]) * i // steps)
    time.sleep(0.05)
    xtest.fake_input(d, X.ButtonRelease, button)
    d.sync()


def grab(d, rect=None):
    from Xlib import X
    root = d.screen().root
    g = root.get_geometry()
    x, y, w, h = rect if rect else (0, 0, g.width, g.height)
    x, y = max(0, x), max(0, y)
    w, h = min(w, g.width - x), min(h, g.height - y)
    raw = root.get_image(x, y, w, h, X.ZPixmap, 0xFFFFFFFF)
    return Image.frombytes("RGB", (w, h), raw.data, "raw", "BGRX")


def stats(img):
    """Counts in a picture (or a crop): pixels of the pinkish red the World Editor writes "Game View Settings"
    in (red well above green and blue), dark pixels (a menu's check mark, text), the mean colour, and a hash
    of the pixels (to tell frames apart)."""
    import hashlib
    rgb = img.convert("RGB")
    px = rgb.load()
    w, h = rgb.size
    red = dark = black = 0
    sr = sg = sb = 0
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            sr += r
            sg += g
            sb += b
            if r > 150 and r - g > 60 and r - b > 30:
                red += 1
            if r + g + b < 200:
                dark += 1
            if r + g + b < 24:
                black += 1
    n = max(1, w * h)
    return {"pixels": w * h, "redPixels": red, "darkPixels": dark, "blackPixels": black, "mean": [sr // n, sg // n, sb // n],
            "md5": hashlib.md5(rgb.tobytes()).hexdigest()}


def frames(d, rect, ms):
    """Grabs a part of the screen as fast as it can for `ms` and counts how often it changed: a lower bound of
    the frames drawn there (a view that animates by itself, like the editor's day and night, changes every frame)."""
    import hashlib
    import time
    end = time.monotonic() + ms / 1000
    grabs = changes = 0
    last = None
    while time.monotonic() < end:
        h = hashlib.md5(grab(d, rect).tobytes()).digest()
        grabs += 1
        if last is not None and h != last:
            changes += 1
        last = h
    secs = ms / 1000
    return {"ms": ms, "grabs": grabs, "changes": changes, "grabsPerSecond": round(grabs / secs, 1),
            "changesPerSecond": round(changes / secs, 1)}


def close_window(d, wid):
    """Asks a window to close as a window manager's close button would (WM_DELETE_WINDOW)."""
    from Xlib import X
    from Xlib.protocol import event
    w = d.create_resource_object("window", wid)
    proto, delete = d.intern_atom("WM_PROTOCOLS"), d.intern_atom("WM_DELETE_WINDOW")
    ev = event.ClientMessage(window=w, client_type=proto, data=(32, [delete, X.CurrentTime, 0, 0, 0]))
    w.send_event(ev, event_mask=X.NoEventMask)
    d.sync()


def main(argv):
    disp = None
    if len(argv) >= 2 and argv[0] == "--display":
        disp, argv = argv[1], argv[2:]
    if not argv:
        raise SystemExit(__doc__)
    cmd, rest = argv[0], argv[1:]

    def opt(name, default=None):
        if name in rest:
            i = rest.index(name)
            v = rest[i + 1]
            del rest[i:i + 2]
            return v
        return default

    def flag(name):
        if name in rest:
            rest.remove(name)
            return True
        return False

    if cmd == "stats" and disp is None:
        rect = opt("--rect")
        img = Image.open(rest[0])
        if rect:
            x, y, w, h = parse_rect(rect)
            img = img.crop((x, y, x + w, y + h))
        out(stats(img))
        return 0

    d = connect(disp)
    if cmd == "windows":
        out({"windows": windows(d)})
    elif cmd == "key":
        win = opt("--window")
        if win:
            focus(d, int(win, 0))
        press_key(d, rest[0])
        out({"key": rest[0]})
    elif cmd == "click":
        button = int(opt("--button", "1"))
        double = flag("--double")
        x, y = (int(v) for v in rest[0].split(","))
        click(d, x, y, button, double)
        out({"click": [x, y], "button": button})
    elif cmd == "move":
        x, y = (int(v) for v in rest[0].split(","))
        move(d, x, y)
        out({"move": [x, y]})
    elif cmd == "drag":
        button = int(opt("--button", "1"))
        a = tuple(int(v) for v in rest[0].split(","))
        b = tuple(int(v) for v in rest[1].split(","))
        drag(d, a, b, button)
        out({"drag": [a, b], "button": button})
    elif cmd == "shot":
        rect = opt("--rect")
        img = grab(d, parse_rect(rect) if rect else None)
        img.save(rest[0])
        out({"shot": rest[0], "size": list(img.size)})
    elif cmd == "focus":
        focus(d, int(rest[0], 0))
        out({"focus": int(rest[0], 0)})
    elif cmd == "close":
        close_window(d, int(rest[0], 0))
        out({"close": int(rest[0], 0)})
    elif cmd == "stats":
        rect = opt("--rect")
        out(stats(grab(d, parse_rect(rect) if rect else None)))
    elif cmd == "frames":
        rect = opt("--rect")
        out(frames(d, parse_rect(rect) if rect else None, int(rest[0])))
    else:
        raise SystemExit(f"unknown command {cmd}")
    return 0


def focus(d, wid):
    from Xlib import X
    w = d.create_resource_object("window", wid)
    w.configure(stack_mode=X.Above)
    w.set_input_focus(X.RevertToParent, X.CurrentTime)
    d.sync()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
