#!/usr/bin/env python3
"""X11 hands for we-drive.mjs: lists windows, presses keys, clicks, takes pictures, on one display (an Xvfb of
its own), through python-xlib and its XTest extension. Every command prints one JSON line.

  we-x11.py --display :N windows                       mapped top-level windows: id, title, class, rect, pid, transient
  we-x11.py --display :N key KEY [--window ID] [--hold MS]  press and release a key ("v", "Escape", "ctrl+s", "alt+F4",
                                                       "Return", "A" and ":" with Shift, "+" and "ctrl++" the plus key),
                                                       held MS (default 50; every key is let go whatever happens); a
                                                       --window that is gone gets nothing ("pressed": false);
                                                       `key --dry KEY` prints how KEY is read (needs no display)
  we-x11.py --display :N numlock on|off|status [--window ID]  Num Lock as the X server holds it; on/off press Num_Lock
                                                       only when it differs ("pressed"), and read it again
  we-x11.py --display :N type TEXT [--window ID]       type TEXT (printable ASCII only: any other character, or one only
                                                       AltGr reaches, refuses the whole text), Shift where a character needs it
  we-x11.py --display :N click X,Y [--button 1|3|4|5] [--double] [--mod alt|shift|ctrl] [--window ID]   click at a screen position (4, 5: a wheel notch), MOD held
  we-x11.py --display :N move X,Y [--window ID]        move the pointer
  we-x11.py --display :N drag X1,Y1 X2,Y2 [--button 1|2|3] [--ms N] [--steps N] [--mod alt|shift|ctrl] [--hold MS] [--window ID] [--dry]
                                                       press at one point, move to the other in steps over MS (default
                                                       400), release; MOD held all the while; --hold MS keeps the
                                                       pointer still MS after the press and before the release; --dry only prints the
                                                       pointer path (needs no display). click, move and drag with a
                                                       --window that is gone or unmapped do nothing ("pressed": false)
  we-x11.py --display :N shot FILE [--rect X,Y,W,H]    picture of the screen (or a part of it) as PNG; a rect is clipped to
                                                       the screen (`rect --dry X,Y,W,H [--screen WxH]` prints the part)
  we-x11.py --display :N clipboard FILE [--target NAME]  the CLIPBOARD selection's text (target UTF8_STRING unless given) into
                                                       FILE; "bytes": null with a "reason" (no owner, refused, timeout,
                                                       incremental, not bytes)
  we-x11.py --display :N focus ID                     give a window the keyboard focus and raise it
  we-x11.py --display :N close ID                      ask a window to close (WM_DELETE_WINDOW); "closed": false for a
                                                       window that is gone or unmapped
  we-x11.py --display :N windows --pics                each window's hash of its picture too ("md5"; not the main window's)
  we-x11.py --display :N stats [--rect X,Y,W,H]        counts of a part of the screen (see stats())
  we-x11.py --display :N frames MS [--rect X,Y,W,H]    how often a part of the screen changes during MS
  we-x11.py --display :N settle [--rect R] [--interval MS] [--timeout MS] [--still SHARE]   wait until two grabs MS apart
                                                       are the same picture (at most --timeout); with --still, until
                                                       two differences in a row change at most SHARE of the pixels
                                                       ("changed": the last share); `settle --dry --hashes a,b,…` (or
                                                       --changes -,0.9,… --still SHARE) runs the rule on given hashes
  we-x11.py stats FILE [--rect X,Y,W,H]                the same counts of a picture

Every command that touches a display is refused (exit 2) unless it is an Xvfb started for tests (guard_decision;
`guard-check --display :N [--procroot DIR]` prints the decision), or W3_ALLOW_REAL_DISPLAY=1 is set.
`--deadline S` (before the command; default 100) ends a command that takes longer (a hung X server) with an error,
as SIGTERM does: held keys and buttons are let go first. A bad argument is a message and exit 1, not a traceback.

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
    """"X,Y,W,H" as four whole numbers, W and H above 0; anything else stops the command with a message."""
    try:
        x, y, w, h = (int(v) for v in s.split(","))
    except ValueError:
        raise SystemExit("--rect wants X,Y,W,H (whole numbers), not %r" % s)
    if w <= 0 or h <= 0:
        raise SystemExit("--rect %r: W and H must be above 0" % s)
    return x, y, w, h


def parse_point(s, what="X,Y"):
    try:
        x, y = (int(v) for v in s.split(","))
    except ValueError:
        raise SystemExit("%s wants X,Y (whole numbers), not %r" % (what, s))
    return x, y


def clamp_rect(rect, width, height):
    """The part of `rect` (x, y, w, h) inside a screen of width x height, or None when nothing of it is: a left or top
    edge past the screen's moves in and the size shrinks with it (a rect at -10 of width 50 is 0 to 40)."""
    x, y, w, h = rect
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(width, x + w), min(height, y + h)
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1 - x0, y1 - y0


def connect(name):
    from Xlib import display
    return display.Display(name)


def set_deadline(seconds):
    """Ends the command with an error after `seconds` (SIGALRM), and on SIGTERM (we-drive's spawn timeout) the same
    way: either raises SystemExit where the command is, so the `finally` blocks release a held key or button instead
    of leaving it down on the display. A connect or sync that hangs (a stuck X server) ends too."""
    import signal

    def stop(signum, frame):
        raise SystemExit("we-x11: %s" % ("timed out after %s s" % seconds if signum == signal.SIGALRM else "stopped (SIGTERM)"))
    signal.signal(signal.SIGTERM, stop)
    if seconds and seconds > 0:
        signal.signal(signal.SIGALRM, stop)
        signal.setitimer(signal.ITIMER_REAL, seconds)


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


def parse_key_spec(spec):
    """"ctrl+shift+s" into (["ctrl", "shift"], "s"). "+" alone is the plus key, and so is a last "+" after a "+"
    ("ctrl++"). An unknown modifier or an empty part stops the command with a message (not a traceback)."""
    if spec == "+":
        return [], "+"
    if spec.endswith("++"):
        mods, key = spec[:-2].split("+"), "+"
    else:
        parts = spec.split("+")
        mods, key = parts[:-1], parts[-1]
    if not key or any(not m for m in mods):
        raise SystemExit("key %r: an empty part (KEY, or MOD+KEY: ctrl+s, shift+Up, ctrl++)" % spec)
    for m in mods:
        if m.lower() not in MODS:
            raise SystemExit("key %r: unknown modifier %r (known: %s)" % (spec, m, ", ".join(sorted(MODS))))
    return [m.lower() for m in mods], key


def char_key(d, ch):
    """The (keycode, shifted) that types the single printable ASCII character `ch` on the display's keyboard map: its
    plain level, or the Shift level (a capital, ':', '+'). Another level (AltGr) or a character outside printable ASCII
    stops the command: pressing some other key instead would type a different character without a word."""
    from Xlib import XK
    if len(ch) != 1 or not (0x20 <= ord(ch) <= 0x7e):
        raise SystemExit("can't type %r: only printable ASCII is typed (a path, a number, a name)" % ch)
    sym = XK.string_to_keysym({"\\": "backslash", " ": "space"}.get(ch, ch))
    if sym == 0:
        sym = ord(ch)
    codes = [c for c in d.keysym_to_keycodes(sym) if c[1] in (0, 1)]
    if not codes:
        raise SystemExit("can't type %r: it isn't on a plain or Shift level of the keyboard map" % ch)
    code, index = min(codes, key=lambda c: c[1])
    return code, index == 1


def press_key(d, spec, hold_ms=50):
    """Presses KEY (with its modifiers) and lets go after `hold_ms`. A single character on the Shift level of the
    keyboard map ("A", ":", "+") gets Shift too; a named key ("KP_6", "Up") is pressed as it is (Shift would turn a
    number pad digit into its arrow under Num Lock). Whatever happens meanwhile (a deadline, SIGTERM), every key that
    went down is let go."""
    from Xlib import X
    from Xlib.ext import xtest
    import time
    mods, name = parse_key_spec(spec)
    if len(name) == 1:
        key, shifted = char_key(d, name)
        if shifted and "shift" not in mods:
            mods = mods + ["shift"]
    else:
        key = keycode(d, name)
    codes = [keycode(d, MODS[m]) for m in mods]
    down = []
    try:
        for m in codes:
            xtest.fake_input(d, X.KeyPress, m)
            down.append(m)
        d.sync()
        xtest.fake_input(d, X.KeyPress, key)
        down.append(key)
        d.sync()
        time.sleep(hold_ms / 1000)
    finally:
        for c in reversed(down):
            xtest.fake_input(d, X.KeyRelease, c)
        d.sync()


def type_text(d, text):
    """Types `text` character by character, with Shift where the keyboard map has the character on the shifted level
    (a Windows path's ':' and capitals, a file dialog's name field). Every character is checked first (char_key): a
    text with one that can't be typed types nothing."""
    from Xlib import X
    from Xlib.ext import xtest
    import time
    shift = keycode(d, "Shift_L")
    plan = [char_key(d, ch) for ch in text]
    for code, shifted in plan:
        down = []
        try:
            if shifted:
                xtest.fake_input(d, X.KeyPress, shift)
                down.append(shift)
            xtest.fake_input(d, X.KeyPress, code)
            down.append(code)
        finally:
            for c in reversed(down):
                xtest.fake_input(d, X.KeyRelease, c)
            d.sync()
        time.sleep(0.02)


def numlock_on(d):
    """Whether Num Lock is on: the bit of the modifier Num_Lock is mapped to (mod2 on Xvfb's map) in the pointer's
    modifier state. The X server keeps the lock across editors started on the same display."""
    from Xlib import XK
    code = d.keysym_to_keycode(XK.string_to_keysym("Num_Lock"))
    for i, codes in enumerate(d.get_modifier_mapping()):
        if code and code in codes:
            return bool(d.screen().root.query_pointer().mask & (1 << i))
    raise SystemExit("Num_Lock is mapped to no modifier on this display")


def move(d, x, y):
    from Xlib import X
    from Xlib.ext import xtest
    xtest.fake_input(d, X.MotionNotify, x=x, y=y)
    d.sync()


def click(d, x, y, button=1, double=False, mod=None):
    """A click (buttons 4 and 5: a wheel notch); `mod` (a MODS name) is held around it and always let go."""
    from Xlib import X
    from Xlib.ext import xtest
    import time
    modkey = keycode(d, MODS[mod.lower()]) if mod else None
    move(d, x, y)
    time.sleep(0.05)
    try:
        if modkey is not None:
            xtest.fake_input(d, X.KeyPress, modkey)
            d.sync()
            time.sleep(0.05)
        for _ in range(2 if double else 1):
            xtest.fake_input(d, X.ButtonPress, button)
            d.sync()
            time.sleep(0.05)
            xtest.fake_input(d, X.ButtonRelease, button)
            d.sync()
            time.sleep(0.05)
    finally:
        if modkey is not None:
            xtest.fake_input(d, X.KeyRelease, modkey)
            d.sync()


def drag_path(a, b, steps):
    """The pointer positions after the press: `steps` points on the line from a to b, the last one b."""
    steps = max(1, steps)
    return [(a[0] + (b[0] - a[0]) * i // steps, a[1] + (b[1] - a[1]) * i // steps) for i in range(1, steps + 1)]


def drag(d, a, b, button=1, ms=400, steps=20, mod=None, hold=0):
    """Press at a, move to b in `steps` over `ms`, release. `hold` (ms) keeps the pointer still with the button down at
    a before the first motion and at b before the release: the World Editor reads the pointer once a frame, so at a
    capped frame rate a press followed at once by motion is seen somewhere along the path, not at a."""
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
        time.sleep(hold / 1000)
        for p in drag_path(a, b, steps):
            time.sleep(ms / 1000 / max(1, steps))
            move(d, *p)
        time.sleep(max(0.05, hold / 1000))
    finally:
        xtest.fake_input(d, X.ButtonRelease, button)
        if modkey is not None:
            xtest.fake_input(d, X.KeyRelease, modkey)
        d.sync()


def grab(d, rect=None):
    from Xlib import X
    root = d.screen().root
    g = root.get_geometry()
    part = clamp_rect(rect, g.width, g.height) if rect else (0, 0, g.width, g.height)
    if part is None:
        raise SystemExit("the rect %s is outside the %dx%d screen" % (",".join(map(str, rect)), g.width, g.height))
    x, y, w, h = part
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
    if ms <= 0:
        raise SystemExit("frames wants MS above 0, not %s" % ms)
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


def settle(grab_hash, sleep_ms, now_ms, timeout_ms, interval_ms, change=None, still=None):
    """Grabs every `interval_ms` until two grabs in a row are the same picture (the view stands still), at most
    `timeout_ms`. `grab_hash` returns a picture (or its hash; None: no more pictures, the dry run's end).
    With `still` (a share of the pixels, 0 to 1) and `change(a, b)` (the share of the pixels that differ between two
    pictures), the view counts as standing still once two differences in a row (three grabs) are at most `still`, or
    one is nothing: what never stops moving (a start location's turning marker, the scrolling message lines, an idle
    unit) doesn't keep a view that has otherwise stopped from settling, while a camera move changes most of the view.
    "changed" is the last share seen."""
    start = now_ms()
    last = grab_hash()
    grabs = 1
    changed, small = None, 0
    while last is not None and now_ms() - start < timeout_ms:
        sleep_ms(interval_ms)
        h = grab_hash()
        if h is None:
            break
        grabs += 1
        if still is not None and change is not None:
            changed = change(last, h)
            small = small + 1 if changed <= still else 0
            same = changed == 0 or small >= 2
        else:
            same = h == last
        if same:
            res = {"settled": True, "ms": now_ms() - start, "grabs": grabs}
            if still is not None:
                res["changed"] = changed
            return res
        last = h
    res = {"settled": False, "ms": now_ms() - start, "grabs": grabs}
    if still is not None:
        res["changed"] = changed
    return res


def changed_share(a, b):
    """The share of the pixels (0 to 1, 4 decimals) that differ between two pictures of one size."""
    from PIL import ImageChops
    d = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v else 0)
    return round(d.histogram()[255] / (a.width * a.height), 4)


def parse_share(text):
    """A share of the pixels, 0 to 1; None for None or ""."""
    if not text:
        return None
    try:
        v = float(text)
    except ValueError:
        v = -1
    if not 0 <= v <= 1:
        raise SystemExit("--still wants a share of the pixels from 0 to 1, e.g. 0.15: %r" % text)
    return v


def viewable(d, wid):
    """Whether the window exists and is mapped (False for one that is gone: no BadWindow error)."""
    from Xlib import X, error
    try:
        return d.create_resource_object("window", wid).get_attributes().map_state == X.IsViewable
    except error.XError:
        return False


def close_window(d, wid):
    """Asks a window to close as a window manager's close button would (WM_DELETE_WINDOW). Returns (asked, reason):
    a window that is gone or unmapped isn't asked (the step would otherwise report a close that never happened)."""
    from Xlib import X, error
    from Xlib.protocol import event
    if not viewable(d, wid):
        return False, "window %s is gone or not mapped" % wid
    w = d.create_resource_object("window", wid)
    proto, delete = d.intern_atom("WM_PROTOCOLS"), d.intern_atom("WM_DELETE_WINDOW")
    ev = event.ClientMessage(window=w, client_type=proto, data=(32, [delete, X.CurrentTime, 0, 0, 0]))
    caught = error.CatchError(error.BadWindow)
    w.send_event(ev, event_mask=X.NoEventMask, onerror=caught)
    d.sync()
    if caught.get_error() is not None:
        return False, "window %s went away before the close" % wid
    return True, None


def main(argv):
    disp = None
    deadline = 100.0
    while len(argv) >= 2 and argv[0] in ("--display", "--deadline"):
        if argv[0] == "--display":
            disp = argv[1]
        else:
            try:
                deadline = float(argv[1])
            except ValueError:
                raise SystemExit("--deadline wants seconds, not %r" % argv[1])
        argv = argv[2:]
    if not argv:
        raise SystemExit(__doc__)
    cmd, rest = argv[0], argv[1:]

    def opt(name, default=None):
        if name in rest:
            i = rest.index(name)
            if i + 1 >= len(rest):
                raise SystemExit("%s needs a value" % name)
            v = rest[i + 1]
            del rest[i:i + 2]
            return v
        return default

    def num(name, default):
        v = opt(name, default)
        try:
            return int(v)
        except (TypeError, ValueError):
            raise SystemExit("%s wants a whole number, not %r" % (name, v))

    def arg(i, what):
        if len(rest) <= i:
            raise SystemExit("%s needs %s" % (cmd, what))
        return rest[i]

    def window_gone(extra):
        """--window ID given and that window gone or unmapped: prints the step's answer ("pressed": false) and says so."""
        win = opt("--window")
        if win and not viewable(d, int(win, 0)):
            out(dict(extra, pressed=False, reason="window %s is gone or not mapped" % win))
            return True
        return False

    def flag(name):
        if name in rest:
            rest.remove(name)
            return True
        return False

    if cmd == "key" and flag("--dry"):
        # How a key spec is read (needs no display): its modifiers and its key.
        mods, key = parse_key_spec(arg(0, "KEY"))
        out({"mods": mods, "key": key})
        return 0

    if cmd == "rect" and flag("--dry"):
        # A --rect checked and clipped to a screen of --screen WxH (needs no display): what grab takes.
        w, h = (int(v) for v in opt("--screen", "1600x1000").split("x"))
        part = clamp_rect(parse_rect(arg(0, "X,Y,W,H")), w, h)
        out({"rect": list(part) if part else None})
        return 0

    if cmd == "stats" and disp is None:
        rect = opt("--rect")
        img = pil_image().open(arg(0, "FILE"))
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
        # --hashes a,b,c; or --changes -,0.9,0.05,… with --still SHARE: the share of the pixels changed since the grab
        # before (the first entry is the first grab's and not read)
        clock = [0]
        still = parse_share(opt("--still"))
        given = opt("--changes")
        if given is not None:
            shares = [0.0 if c == "-" else float(c) for c in given.split(",")]
            frames_left = iter(range(len(shares)))
            res = settle(lambda: next(frames_left, None), lambda ms: clock.__setitem__(0, clock[0] + ms), lambda: clock[0],
                         int(opt("--timeout", "10000")), int(opt("--interval", "200")), lambda a, b: shares[b], still)
        else:
            hashes = iter(opt("--hashes", "").split(","))
            res = settle(lambda: next(hashes, None), lambda ms: clock.__setitem__(0, clock[0] + ms), lambda: clock[0],
                         int(opt("--timeout", "10000")), int(opt("--interval", "200")))
        out(res)
        return 0

    if cmd == "guard-check":
        ok, why = guard_decision(opt("--display", disp), opt("--procroot", "/proc"))
        out({"allowed": ok, "reason": why})
        return 0 if ok else 2

    ok, why = guard_with_retries(disp)
    if not ok:
        sys.stderr.write("we-x11: refused, %s\n" % why)
        return 2

    # A command that waits on purpose (a held key, frames, settle) gets its wait on top of the deadline.
    def peek(name):
        try:
            return max(0, int(rest[rest.index(name) + 1])) / 1000
        except (ValueError, IndexError):
            return 0
    waits = {"key": peek("--hold"), "settle": peek("--timeout") or 10, "drag": peek("--ms") + 2 * peek("--hold")}
    if cmd == "frames":
        try:
            waits["frames"] = max(0, int(rest[0])) / 1000
        except (ValueError, IndexError):
            pass
    set_deadline(deadline + waits.get(cmd, 0) if deadline > 0 else 0)
    d = connect(disp)
    if cmd == "windows":
        ws = windows(d)
        if flag("--pics"):
            # A hash of the picture under every window but the editor's main one (its terrain view redraws all the
            # time): what we-drive --idle watches, in the same call as the list.
            import hashlib
            for w in ws:
                if w["title"].startswith("Warcraft III World Editor") and w["rect"][2] > 800:
                    continue
                try:
                    w["md5"] = hashlib.md5(grab(d, w["rect"]).tobytes()).hexdigest()
                except SystemExit:
                    pass
        out({"windows": ws})
    elif cmd == "key":
        # A --window that is gone (a dialog that just closed) gets no key: it would land in whatever has the focus.
        win = opt("--window")
        hold = num("--hold", "50")
        spec = arg(0, "KEY")
        parse_key_spec(spec)
        if win and not focus(d, int(win, 0)):
            out({"key": spec, "holdMs": hold, "pressed": False, "reason": "window %s is gone or not mapped" % win})
            return 0
        press_key(d, spec, hold)
        out({"key": spec, "holdMs": hold, "pressed": True})
    elif cmd == "numlock":
        # Num Lock to a state (on, off) or only read (status): pressed only when it differs, read again after.
        want = arg(0, "on, off or status")
        if want not in ("on", "off", "status"):
            raise SystemExit("numlock wants on, off or status, not %r" % want)
        win = opt("--window")
        was = numlock_on(d)
        pressed = False
        if want != "status" and was != (want == "on"):
            if win and not focus(d, int(win, 0)):
                out({"numlock": "on" if was else "off", "was": "on" if was else "off", "pressed": False, "reason": "window %s is gone or not mapped" % win})
                return 0
            press_key(d, "Num_Lock")
            pressed = True
        now = numlock_on(d)
        out({"numlock": "on" if now else "off", "was": "on" if was else "off", "pressed": pressed})
    elif cmd == "type":
        win = opt("--window")
        text = arg(0, "TEXT")
        for ch in text:
            char_key(d, ch)
        if win and not focus(d, int(win, 0)):
            out({"typed": 0, "pressed": False, "reason": "window %s is gone or not mapped" % win})
            return 0
        type_text(d, text)
        out({"typed": len(text), "pressed": True})
    elif cmd == "click":
        button = num("--button", "1")
        double = flag("--double")
        mod = opt("--mod")
        if mod and mod.lower() not in MODS:
            raise SystemExit("click: unknown --mod %r (known: %s)" % (mod, ", ".join(sorted(MODS))))
        x, y = parse_point(arg(0, "X,Y"), "click")
        if window_gone({"click": [x, y], "button": button}):
            return 0
        click(d, x, y, button, double, mod)
        out({"click": [x, y], "button": button})
    elif cmd == "move":
        x, y = parse_point(arg(0, "X,Y"), "move")
        if window_gone({"move": [x, y]}):
            return 0
        move(d, x, y)
        out({"move": [x, y]})
    elif cmd == "drag":
        button = num("--button", "1")
        ms = num("--ms", "400")
        steps = num("--steps", "20")
        hold = max(0, num("--hold", "0"))
        mod = opt("--mod")
        if mod and mod.lower() not in MODS:
            raise SystemExit("drag: unknown --mod %r (known: %s)" % (mod, ", ".join(sorted(MODS))))
        a = parse_point(arg(0, "X1,Y1 X2,Y2"), "drag")
        b = parse_point(arg(1, "X1,Y1 X2,Y2"), "drag")
        if window_gone({"drag": [a, b], "button": button}):
            return 0
        drag(d, a, b, button, ms, steps, mod, hold)
        out({"drag": [a, b], "button": button})
    elif cmd == "shot":
        rect = opt("--rect")
        img = grab(d, parse_rect(rect) if rect else None)
        img.save(arg(0, "FILE"))
        out({"shot": rest[0], "size": list(img.size)})
    elif cmd == "clipboard":
        file = arg(0, "FILE")
        data, reason = clipboard_text(d, opt("--target", "UTF8_STRING"))
        if data is None:
            out({"clipboard": file, "bytes": None, "reason": reason})
        else:
            with open(file, "wb") as f:
                f.write(data)
            out({"clipboard": file, "bytes": len(data), "crlf": data.count(bytes([13, 10])), "lf": data.count(bytes([10]))})
    elif cmd == "focus":
        wid = int(arg(0, "ID"), 0)
        out({"focus": wid, "focused": focus(d, wid)})
    elif cmd == "close":
        wid = int(arg(0, "ID"), 0)
        asked, reason = close_window(d, wid)
        out(dict({"close": wid, "closed": asked}, **({"reason": reason} if reason else {})))
    elif cmd == "stats":
        rect = opt("--rect")
        out(stats(grab(d, parse_rect(rect) if rect else None)))
    elif cmd == "frames":
        rect = opt("--rect")
        try:
            ms = int(arg(0, "MS"))
        except ValueError:
            raise SystemExit("frames wants MS, a whole number")
        out(frames(d, parse_rect(rect) if rect else None, ms))
    elif cmd == "settle":
        import hashlib
        import time
        rect = opt("--rect")
        r = parse_rect(rect) if rect else None
        still = parse_share(opt("--still"))
        if still is not None:
            out(settle(lambda: grab(d, r), lambda ms: time.sleep(ms / 1000), lambda: time.monotonic() * 1000,
                       num("--timeout", "10000"), num("--interval", "200"), changed_share, still))
        else:
            out(settle(lambda: hashlib.md5(grab(d, r).tobytes()).digest(), lambda ms: time.sleep(ms / 1000),
                       lambda: time.monotonic() * 1000, num("--timeout", "10000"), num("--interval", "200")))
    else:
        raise SystemExit(f"unknown command {cmd}")
    return 0


def clipboard_text(d, target="UTF8_STRING", timeout=3.0):
    """The CLIPBOARD selection as (bytes, None), or (None, reason): "no owner" (nobody holds it), "refused" (the owner
    can't give it as `target`), "timeout" (no answer in `timeout` s), "incremental" (the owner sends it in parts, INCR,
    which this doesn't read), "not bytes" (an answer of another format). A window of ours asks the owner to convert it
    (ConvertSelection); the answer is read from that window's property."""
    import time
    from Xlib import X
    clip, tgt, dest = d.intern_atom("CLIPBOARD"), d.intern_atom(target), d.intern_atom("W3_CLIP")
    if d.get_selection_owner(clip) == X.NONE:
        return None, "no owner"
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
                        return None, "refused"
                    p = win.get_full_property(dest, X.AnyPropertyType)
                    if p is not None and p.property_type == d.intern_atom("INCR"):
                        return None, "incremental"
                    if p is not None and isinstance(p.value, (bytes, bytearray)):
                        return bytes(p.value), None
                    return None, "not bytes"
            time.sleep(0.02)
        return None, "timeout"
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
