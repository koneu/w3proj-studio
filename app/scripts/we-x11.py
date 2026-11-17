#!/usr/bin/env python3
"""X11 hands for we-drive.mjs: lists windows, presses keys, clicks, takes pictures, on one display (an Xvfb of
its own), through python-xlib and its XTest extension. Every command prints one JSON line.

  we-x11.py --display :N windows                       mapped top-level windows: id, title, class, rect, pid, transient
  we-x11.py --display :N key KEY [--window ID] [--hold MS]  press and release a key ("v", "Escape", "ctrl+s", "alt+F4",
                                                       "Return"), held MS (default 50); a --window that is gone gets
                                                       nothing ("pressed": false)
  we-x11.py --display :N type TEXT [--window ID]       type TEXT, with Shift where a character needs it (a path)
  we-x11.py --display :N click X,Y [--button 1|3] [--double]   click at a screen position
  we-x11.py --display :N move X,Y                      move the pointer
  we-x11.py --display :N drag X1,Y1 X2,Y2 [--button 1|2|3] [--ms N] [--steps N] [--mod alt|shift|ctrl] [--dry]
                                                       press at one point, move to the other in steps over MS (default
                                                       400), release; MOD held all the while; --dry only prints the
                                                       pointer path (needs no display)
  we-x11.py --display :N shot FILE [--rect X,Y,W,H]    picture of the screen (or a part of it) as PNG
  we-x11.py --display :N clipboard FILE [--target NAME]  the CLIPBOARD selection's text (target UTF8_STRING unless given) into
                                                       FILE; "bytes": null when nobody owns it
  we-x11.py --display :N focus ID                     give a window the keyboard focus and raise it
  we-x11.py --display :N close ID                      ask a window to close (WM_DELETE_WINDOW)
  we-x11.py --display :N stats [--rect X,Y,W,H]        counts of a part of the screen (see stats())
  we-x11.py --display :N frames MS [--rect X,Y,W,H]    how often a part of the screen changes during MS
  we-x11.py --display :N settle [--rect R] [--interval MS] [--timeout MS]   wait until two grabs MS apart are the same
                                                       picture (at most --timeout); `settle --dry --hashes a,b,…` runs
                                                       the rule on given hashes
  we-x11.py stats FILE [--rect X,Y,W,H]                the same counts of a picture

Every command that touches a display is refused (exit 2) unless it is an Xvfb started for tests (guard_decision;
`guard-check --display :N [--procroot DIR]` prints the decision), or W3_ALLOW_REAL_DISPLAY=1 is set.

Run with `python3 -I` (we-drive does) so nothing in the working folder is imported.
"""

import json
import os
import re
import sys


def pil_image():
    """Pillow, imported where pictures are made: the guard and the key/click commands work without it."""
    from PIL import Image
    return Image


def out(obj):
    print(json.dumps(obj))
    sys.stdout.flush()


def guard_decision(display, procroot="/proc", environ=None):
    """(allowed, reason): input goes only to an Xvfb that someone started for a test, never to a desktop session.
    Allowed: a local display ":N" with an Xvfb process (argv[0] named Xvfb) that either has ":N" in its arguments or
    holds the listening socket X<N> itself (-displayfd picks the number itself; matched by the socket's inode in its own fd links). W3_ALLOW_REAL_DISPLAY=1 overrides, for the
    user's own manual use. A missing --display is refused (Xlib would take $DISPLAY, the desktop)."""
    environ = os.environ if environ is None else environ
    if environ.get("W3_ALLOW_REAL_DISPLAY") == "1":
        return True, "W3_ALLOW_REAL_DISPLAY=1"
    if not display:
        return False, "no --display given (the desktop's $DISPLAY must never be used by default)"
    m = re.fullmatch(r":(\d+)(\.\d+)?", display)
    if not m:
        return False, "display %r is not a local display of the form :N" % display
    num = m.group(1)
    try:
        pids = [e for e in os.listdir(procroot) if e.isdigit()]
    except OSError:
        pids = []
    for pid in pids:
        try:
            with open(os.path.join(procroot, pid, "cmdline"), "rb") as f:
                argv = [a.decode("utf-8", "replace") for a in f.read().split(b"\0") if a]
        except OSError:
            continue
        if not argv or os.path.basename(argv[0]) != "Xvfb":
            continue
        if any(a == ":" + num for a in argv):
            return True, "Xvfb pid " + pid
        if "-displayfd" in argv:
            # /proc/<pid>/net/unix lists every unix socket of the machine (the desktop's X0 too), so only a socket
            # this very process holds open (its fd links, matched by inode) counts as its display.
            own = set()
            try:
                fds = os.listdir(os.path.join(procroot, pid, "fd"))
            except OSError:
                continue
            for fd in fds:
                # A client's fd can close between the listing and the readlink: that one fd is skipped, not the
                # whole Xvfb (which once refused the run's own display: "is not an Xvfb started for tests").
                try:
                    m2 = re.fullmatch(r"socket:\[(\d+)\]", os.readlink(os.path.join(procroot, pid, "fd", fd)))
                except OSError:
                    continue
                if m2:
                    own.add(m2.group(1))
            try:
                with open(os.path.join(procroot, pid, "net", "unix"), "r", errors="replace") as f:
                    for line in f:
                        cols = line.split()
                        if len(cols) >= 8 and cols[6] in own and re.search(r"\.X11-unix/X%s$" % num, cols[7]):
                            return True, "Xvfb pid %s (-displayfd)" % pid
            except OSError:
                pass
    return False, "display %s is not an Xvfb started for tests (set W3_ALLOW_REAL_DISPLAY=1 to use a real one on purpose)" % display


def guard_with_retries(display, procroot="/proc", environ=None, tries=3, pause=0.4, decide=None):
    """guard_decision, asked again (`tries` times, `pause` s apart) before refusing: /proc changes under the scan
    (a process or an fd going away), and a refusal of the run's own Xvfb ends the run. A display that is refused for
    its form (or a missing one) isn't asked again."""
    import time
    decide = decide or guard_decision
    ok, why = decide(display, procroot, environ)
    for _ in range(tries - 1):
        if ok or not display or not re.fullmatch(r":(\d+)(\.\d+)?", display):
            break
        time.sleep(pause)
        ok, why = decide(display, procroot, environ)
    return ok, why


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


def press_key(d, spec, hold_ms=50):
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
    time.sleep(hold_ms / 1000)
    xtest.fake_input(d, X.KeyRelease, key)
    for m in reversed(mods):
        xtest.fake_input(d, X.KeyRelease, m)
    d.sync()


def type_text(d, text):
    """Types `text` character by character, with Shift where the keyboard map has the character on the shifted level
    (a Windows path's ':' and capitals, a file dialog's name field)."""
    from Xlib import X, XK
    from Xlib.ext import xtest
    import time
    shift = keycode(d, "Shift_L")
    for ch in text:
        sym = XK.string_to_keysym({"\\": "backslash", " ": "space"}.get(ch, ch))
        if sym == 0:
            sym = ord(ch)
        codes = list(d.keysym_to_keycodes(sym))
        if not codes:
            raise SystemExit(f"no keycode for {ch!r}")
        code, index = min(codes, key=lambda c: c[1])
        if index & 1:
            xtest.fake_input(d, X.KeyPress, shift)
        xtest.fake_input(d, X.KeyPress, code)
        xtest.fake_input(d, X.KeyRelease, code)
        if index & 1:
            xtest.fake_input(d, X.KeyRelease, shift)
        d.sync()
        time.sleep(0.02)


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


def drag_path(a, b, steps):
    """The pointer positions after the press: `steps` points on the line from a to b, the last one b."""
    steps = max(1, steps)
    return [(a[0] + (b[0] - a[0]) * i // steps, a[1] + (b[1] - a[1]) * i // steps) for i in range(1, steps + 1)]


def drag(d, a, b, button=1, ms=400, steps=20, mod=None):
    from Xlib import X
    from Xlib.ext import xtest
    import time
    modkey = keycode(d, MODS[mod.lower()]) if mod else None
    move(d, *a)
    time.sleep(0.05)
    try:
        if modkey is not None:
            xtest.fake_input(d, X.KeyPress, modkey)
            d.sync()
            time.sleep(0.05)
        xtest.fake_input(d, X.ButtonPress, button)
        d.sync()
        for p in drag_path(a, b, steps):
            time.sleep(ms / 1000 / max(1, steps))
            move(d, *p)
        time.sleep(0.05)
    finally:
        xtest.fake_input(d, X.ButtonRelease, button)
        if modkey is not None:
            xtest.fake_input(d, X.KeyRelease, modkey)
        d.sync()


def grab(d, rect=None):
    from Xlib import X
    root = d.screen().root
    g = root.get_geometry()
    x, y, w, h = rect if rect else (0, 0, g.width, g.height)
    x, y = max(0, x), max(0, y)
    w, h = min(w, g.width - x), min(h, g.height - y)
    raw = root.get_image(x, y, w, h, X.ZPixmap, 0xFFFFFFFF)
    return pil_image().frombytes("RGB", (w, h), raw.data, "raw", "BGRX")


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


def settle(grab_hash, sleep_ms, now_ms, timeout_ms, interval_ms):
    """Grabs every `interval_ms` until two grabs in a row are the same picture (the view stands still), at most
    `timeout_ms`. `grab_hash` returns a picture's hash (None: no more pictures, the dry run's end)."""
    start = now_ms()
    last = grab_hash()
    grabs = 1
    while last is not None and now_ms() - start < timeout_ms:
        sleep_ms(interval_ms)
        h = grab_hash()
        if h is None:
            break
        grabs += 1
        if h == last:
            return {"settled": True, "ms": now_ms() - start, "grabs": grabs}
        last = h
    return {"settled": False, "ms": now_ms() - start, "grabs": grabs}


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
        img = pil_image().open(rest[0])
        if rect:
            x, y, w, h = parse_rect(rect)
            img = img.crop((x, y, x + w, y + h))
        out(stats(img))
        return 0

    if cmd == "drag" and flag("--dry"):
        a = tuple(int(v) for v in rest[0].split(","))
        b = tuple(int(v) for v in rest[1].split(","))
        out({"path": drag_path(a, b, int(opt("--steps", "20")))})
        return 0

    if cmd == "settle" and flag("--dry"):
        # The settle rule on a list of frame hashes, one per --interval of a made-up clock (needs no display):
        # --hashes a,b,c
        hashes = iter(opt("--hashes", "").split(","))
        clock = [0]
        out(settle(lambda: next(hashes, None), lambda ms: clock.__setitem__(0, clock[0] + ms), lambda: clock[0],
                   int(opt("--timeout", "10000")), int(opt("--interval", "200"))))
        return 0

    if cmd == "guard-check":
        ok, why = guard_decision(opt("--display", disp), opt("--procroot", "/proc"))
        out({"allowed": ok, "reason": why})
        return 0 if ok else 2

    ok, why = guard_with_retries(disp)
    if not ok:
        sys.stderr.write("we-x11: refused, %s\n" % why)
        return 2

    d = connect(disp)
    if cmd == "windows":
        out({"windows": windows(d)})
    elif cmd == "key":
        # A --window that is gone (a dialog that just closed) gets no key: it would land in whatever has the focus.
        win = opt("--window")
        hold = int(opt("--hold", "50"))
        if win and not focus(d, int(win, 0)):
            out({"key": rest[0], "holdMs": hold, "pressed": False, "reason": "window %s is gone or not mapped" % win})
            return 0
        press_key(d, rest[0], hold)
        out({"key": rest[0], "holdMs": hold, "pressed": True})
    elif cmd == "type":
        win = opt("--window")
        if win and not focus(d, int(win, 0)):
            out({"typed": 0, "pressed": False, "reason": "window %s is gone or not mapped" % win})
            return 0
        type_text(d, rest[0])
        out({"typed": len(rest[0]), "pressed": True})
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
        ms = int(opt("--ms", "400"))
        steps = int(opt("--steps", "20"))
        mod = opt("--mod")
        a = tuple(int(v) for v in rest[0].split(","))
        b = tuple(int(v) for v in rest[1].split(","))
        drag(d, a, b, button, ms, steps, mod)
        out({"drag": [a, b], "button": button})
    elif cmd == "shot":
        rect = opt("--rect")
        img = grab(d, parse_rect(rect) if rect else None)
        img.save(rest[0])
        out({"shot": rest[0], "size": list(img.size)})
    elif cmd == "clipboard":
        data = clipboard_text(d, opt("--target", "UTF8_STRING"))
        if data is None:
            out({"clipboard": rest[0], "bytes": None})
        else:
            with open(rest[0], "wb") as f:
                f.write(data)
            out({"clipboard": rest[0], "bytes": len(data), "crlf": data.count(bytes([13, 10])), "lf": data.count(bytes([10]))})
    elif cmd == "focus":
        out({"focus": int(rest[0], 0), "focused": focus(d, int(rest[0], 0))})
    elif cmd == "close":
        close_window(d, int(rest[0], 0))
        out({"close": int(rest[0], 0)})
    elif cmd == "stats":
        rect = opt("--rect")
        out(stats(grab(d, parse_rect(rect) if rect else None)))
    elif cmd == "frames":
        rect = opt("--rect")
        out(frames(d, parse_rect(rect) if rect else None, int(rest[0])))
    elif cmd == "settle":
        import hashlib
        import time
        rect = opt("--rect")
        r = parse_rect(rect) if rect else None
        out(settle(lambda: hashlib.md5(grab(d, r).tobytes()).digest(), lambda ms: time.sleep(ms / 1000),
                   lambda: time.monotonic() * 1000, int(opt("--timeout", "10000")), int(opt("--interval", "200"))))
    else:
        raise SystemExit(f"unknown command {cmd}")
    return 0


def clipboard_text(d, target="UTF8_STRING", timeout=3.0):
    """The CLIPBOARD selection as bytes, or None when nobody owns it or it doesn't answer in time. A window of ours asks
    the owner to convert it (ConvertSelection); the answer is read from that window's property."""
    import time
    from Xlib import X
    clip, tgt, dest = d.intern_atom("CLIPBOARD"), d.intern_atom(target), d.intern_atom("W3_CLIP")
    if d.get_selection_owner(clip) == X.NONE:
        return None
    win = d.screen().root.create_window(0, 0, 1, 1, 0, X.CopyFromParent, event_mask=X.PropertyChangeMask)
    try:
        win.convert_selection(clip, tgt, dest, X.CurrentTime)
        d.flush()
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            while d.pending_events():
                ev = d.next_event()
                if ev.type == X.SelectionNotify:
                    if ev.property == X.NONE:
                        return None
                    p = win.get_full_property(dest, X.AnyPropertyType)
                    return bytes(p.value) if p is not None and isinstance(p.value, (bytes, bytearray)) else None
            time.sleep(0.02)
        return None
    finally:
        win.destroy()
        d.flush()


def focus(d, wid):
    """Raises a window and gives it the keyboard. A window that is gone or not mapped (a dialog that closed a moment
    ago) is left alone: X would answer BadWindow / BadMatch, and only after the sync. Returns whether it was done."""
    from Xlib import X, error
    w = d.create_resource_object("window", wid)
    try:
        if w.get_attributes().map_state != X.IsViewable:
            return False
    except error.XError:
        return False
    caught = error.CatchError(error.BadWindow, error.BadMatch)
    w.configure(stack_mode=X.Above, onerror=caught)
    w.set_input_focus(X.RevertToParent, X.CurrentTime, onerror=caught)
    d.sync()
    return caught.get_error() is None


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
