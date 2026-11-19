# The real World Editor: how we-drive works

Setup, layout, timings, hygiene, slots, editor CPU and the renderer choice: the measured details behind we-drive.mjs. Part of the [testing guide](../../TESTING.md); index in [README](README.md).

**Local only: it needs the installed game, Proton, Xvfb, bubblewrap, a C compiler, python3 with python-xlib and Pillow,
and Mesa's lavapipe; it is not part of CI or the gate.** Without one of them it prints `{"skipped": why}` and exits 0.
It never starts the game itself.

- **Nothing of the user's is touched.** `we-setup.mjs` keeps one farm for all worktrees in `target/we` of the main
  checkout (`W3PROJ_WE_DIR` moves it): `install/` holds hardlinks of the install, except what the editor writes (the
  CASC `.idx` files, `shmem`, `ecache`: about 10 MB of copies), and `prefix/` is a Wine prefix of its own (about
  0.35 GB). The farm is made again only for another game build (`.build.info`), `--clean` removes it all. The editor
  runs in bubblewrap with the whole machine mounted read-only except the farm, its prefix, the run's work folder,
  `$XDG_RUNTIME_DIR` and `/tmp` (`writableDirs`), and with the user's whole Steam prefix and every hardlink read-only
  inside those; `--die-with-parent` takes Proton along when we-drive is killed, and each start kills a leftover
  wineserver of the prefix first; the editor opens the
  CASC data files for writing, so `we-rofs.c` (preloaded) turns those opens into read-only ones. One World Editor runs
  at a time per **slot** (`--slot N` of we-drive, we-compare and we-setup, or `W3PROJ_WE_SLOT`; see "Several editors"
  below): slot 0's lock is `$XDG_RUNTIME_DIR/w3proj-we.lock` (else the temp dir, with the user name), shared by
  every worktree and every `W3PROJ_WE_DIR`, slot N's `w3proj-we-slotN.lock` beside it, with a farm and prefix of its own
  in `target/we-slotN` (`W3PROJ_WE_DIR/slotN`); a second run on a slot says once who holds it and since when, and waits
  (`takeLock`'s timeout; a dead pid is taken over). we-drive takes the lock before it sets the farm up, which may rebuild it
  for another game build; `setup` refuses to replace a farm another live run holds, and the folder must pass `guardedWeDir`
  (inside this repository or the main checkout, not holding or inside the game folder). `we-setup.mjs --snapshot` and `--compare` show the
  install and the user's `Documents/Warcraft III` unchanged; the user's own Battle.net app writes elsewhere in that
  prefix while it runs (and touches the install's `shmem` files when it checks the game), which `--compare` lists.

- **Nothing is ever sent to Blizzard.** The editor crashes on close with View > Light Ranges on, and its crash
  report dialog has "Send to Blizzard" ticked and a text box. The editor's sandbox has no network (`bwrap
  --unshare-net`: the editor's processes see only `lo`; it starts and loads maps as before), and every window list
  we-drive reads (`Session.windows()`, so every step, `--close` included) is checked for that dialog (`crashDialogs`:
  the owning program's name, else title or window class). Seen for real (2026-11-13): the dialog comes after the main
  window has gone, is titled exactly "Warcraft III World Editor" with the editor's class (`steam_app_<appid>`), and
  belongs to `BlizzardError.exe`, so the program name is what finds it. Only argv[0]'s file name counts, and a
  title's `[…]` (the map's path) is left out: paths may say "crash" (a worktree named so once tripped it). On a hit
  it takes a picture of the screen (`dialog-crash-*.png` in the work folder), types and clicks nothing, kills the
  editor, its crash reporter and everything else of its prefix (`wineserver -k` and the process group), and prints
  `crashed: true` with "the World Editor crashed; report dismissed without sending" (`--close` then counts as
  closed; any other step fails). Unticking the box isn't tried. `--close` types "n" only into a window of the main
  window's process: the "Warning" question, or an untitled or editor-titled dialog while the main window exists
  (`closeAction`); anything else of the kind counts as a crash. Tested on the recorded window list
  (`we-drive.test.mjs`); the crash leaves its dump in the farm's prefix (`Documents/Warcraft III/Errors`).

- **Nothing on the screen, no sound.** A display of its own (Xvfb, 1600x1000), Vulkan through lavapipe. Wine's audio
  drivers are off, PulseAudio and PipeWire are pointed at nothing and their sockets and `/dev/snd` are hidden, and
  the editor's interface sounds are off in its preferences: nothing of it shows in `pactl list sink-inputs`.

- **Never the user's desktop.** `we-x11.py` (clicks, keys, drags) refuses with exit 2 unless `--display :N` is an
  Xvfb process (found in `/proc`, by its argument or its `-displayfd` socket); no `--display` is refused too, so
  Xlib never falls back to `$DISPLAY`. `W3_ALLOW_REAL_DISPLAY=1` overrides it, for your own manual use only.
  `webdriver.mjs` (app-smoke, app-drive) and we-drive strip `DISPLAY`, `WAYLAND_DISPLAY` and `XAUTHORITY` from what
  they inherit and start their own Xvfb, or fail. Tested in `input-guard.test.mjs` with a fake `/proc`
  (`we-x11.py guard-check --display :N --procroot DIR`).

- **Preferences** (`Documents/Warcraft III/WorldEditPreferences.txt` in the farm's prefix, written before each start,
  the rest kept): `Has Been Run=true`, no interface or splash sounds, `Fixed Day Night Cycle` from `--day-night`, and
  the graphics: `--mode sd|hd|de` sets `assetMode` to 0, 1 or 2 (File > Preferences > General > Asset Mode offers
  SD, HD, DE; DE is the 3.0 art) and `hd` and the Reforged switches (`Buildings`, `Environment`, `EnvOld`, `Heroes`,
  `Icons`, `Textures`, `Units`, `Vfx`) to 0 for sd, else 1. Told apart (2026-11-13) by pictures of one map in all
  three modes: `assetMode` alone decides (assetMode 2 with every other switch 0 draws DE, assetMode 0 with them all
  1 draws SD); the registry and the install showed no mode value in a before/after diff. SD has round trees, HD flat grass with
  pointed trees, DE feathered pines and a detailed terrain. Switching in the dialog crashes the hidden editor
  (it re-opens its archive over the network), so write the key instead. The install's text locale goes into the prefix's registry (else the editor shows
  `WESTRING_…` names); it must be enUS (we-drive finds the dialogs by their English titles and refuses an install without it). The first start of a new prefix shows the editor's welcome, which asks to accept Blizzard's
  terms. The user accepted them in their own install (which the farm is made from) and agreed on 2026-11-08 that
  we-drive presses Continue in its own prefix; `W3PROJ_WE_ACCEPT_TERMS=0` makes it report the dialog instead. The
  shared prefix keeps the answer, so this comes up once per new prefix.
  Pinned before each start (else written as found, so a run depends on the last; `--keep-prefs` leaves them): `Enforce
  Water Limits` (Ctrl+Shift+W), `Enforce Camera Boundaries`, `Reset Fixed Z When Moving Objects=false` (the switch
  Ctrl+Shift+H toggles: seen 2026-11-17, false to true, kept by the next start when not pinned), the minimap's `Show
  Creep Camps` (PINNED_PREFS). `--pref Section/Key=value`
  (repeatable) writes any other key before each start, `--keep-prefs` or not; we-compare's `we.prefs` passes them.

- Game view: V toggles it, and `--game-view` reads it from View > Lock to Game View Settings. The "Game View Settings"
  label the editor shows in the upper right of the view on the user's machine didn't appear in the hidden display.
  A fog map confirms the state: 02e (exponential fog, density 0.5) is the full map with game view off and nothing but
  fog colour with it on (checked 2026-11-08).

- **Layout** in the fixed display: main window 4,30 1352x937, terrain view 156,79 1184x844, tool palette 1356,30
  240x600. Keys go to the main window (without a window manager the palette keeps the keyboard otherwise). Closing
  answers the "Save changes?" box (titled "Warning") with No; system dialogs are in English.

- **Timings** (this machine): a warm start shows the map after 10–14 s (main window after 6 s), a start with a new
  prefix after 23 s (39 s with closing). The terrain view draws about 14 frames a second in SD and about 2 in HD.

- **Game view** (`V`, View > Lock to Game View Settings) is read from the View menu's check mark. This build draws no
  "Game View Settings" note in the view, so the picture of the view can't tell.

- **Dialogs that don't draw at once**: Scenario > Player Properties (window "Scenario Properties") draws about 3 s
  after the click; before that it is a blank white rectangle in the hidden display. Take pictures at least 3 s after
  a click. A menu left open at `--close` can't be answered by it: never leave one open.

- **Testers' hygiene**: a number field needs Enter (`\r`) or a blur, or `change` never fires and no edit happens (a
  hidden-app dirty-flag reading looked wrong for this reason). Kill processes by PID, never by pattern: a `pkill` by
  pattern once hit another display's Proton services.

- **Loading**: big maps (4v4 Mount Hyjal) show a window titled "Progress" ("Loading Units n/300") for several
  seconds; `--wait-ready` waits for it (up to `--timeout`) instead of reporting it as a question.

- **Waiting for the editor** (branch we-sleeps, 2026-11-19). `node app/scripts/we-sleeps.mjs` counts the fixed pauses of
  the specs by what they follow: 484 specs, 1954 `--sleep` steps (1439 s: 1457 after a click, 394 after a key, 56 after
  another sleep) and 350 Studio `{ "sleep" }` steps (418 s, 174 after a `ui` step). The editor's CPU can't say "quiet":
  at rest (SD, day fixed, map ready) the editor and its Wine processes use about 9 cores without a pause (software GL
  redraws all the time; the view changes 52 times a second), so `--idle` / `--wait-window` (we-idle.mjs) watch what
  is on the screen instead: the window set and a hash of every window's picture but the main one (`we-x11.py windows
  --pics`, one helper call a poll, about 250 ms) unchanged for 400 ms, at least 150 ms, at most `--timeout`. `--wait-window
  TITLE` also waits for the window to exist (the quiet time counts from then); its error names the title. Where a
  spec still sleeps, the effect isn't on a window: a brush click, a key into the view (nothing on the screen to wait
  for; the view never stands still), the Object Editor and Trigger Editor (the window is there long before it paints,
  45 to 90 s: a quiet window isn't a loaded one). Studio's `{ "sleep" }` after `open` is gone from the sound-order specs
  (the step waits for the editor). Measured on the Sound Editor family (`sound-order-sort`, `sound-order-move`,
  `sound-flags-we`, all MATCH after the change): F5 then a sleep of 2000 / 2000 / 2500 ms is now `--wait-window "Sound
  Editor"`, which took 995 / 915 / 921 ms (6.5 s to 2.8 s of waiting); Studio's two `open` sleeps were 0.5 s each (the
  packed maps are byte-identical without them). `w3Workbench.settled()` after opening the Sound Editor takes under 0.1 s
  (10 calls in a row, 1 s for the spec with the open): the 2.9 s seen before was the first spec's cold start (project
  unpack, game files), not the wait.

**Several editors** (branch we-slots, 2026-11-19): World Editors run at once on **slots**. Slot 0 is the farm, prefix
and lock there always were (nothing moves without `--slot`); slot N > 0 has `target/we-slotN` of the main checkout
(`W3PROJ_WE_DIR/slotN`) and the lock `w3proj-we-slotN.lock`, both from `we-setup.mjs` `slotPaths`, so a farm is never
paired with another slot's lock. Its first start sets it up under its lock: farm hardlinks (a second, 1 s), a new prefix
(0.36 GB), the welcome answered (38 s in all). `we-setup.mjs --slot N --clean` removes it. `we-drive --slot N`;
`we-compare --slot N|auto [--slots 0,1,2]` holds the slot's lock for the whole run (its we-drive processes take it over
from it: `W3PROJ_WE_LOCK_HOLDER`, their parent only), `auto` the first free one; work folders default per slot
(`target/we-drive-slotN`, `target/we-compare-slotN`) and `report.json` is in the run's work folder. A full run in n
parts: n runs of `we-compare --slot auto --shard i/n <all spec files>` (i = 1..n, the same files in each): whole files
dealt out by spec count (`shardFiles`: a file's specs stay in order in one editor), every file in exactly one part
(the 120 spec files of `tests/we-compare/`, 484 specs: 242 + 242 for n = 2, 162 + 161 + 161 for n = 3).
What the editors share, checked: the **display** is each run's own Xvfb (`-displayfd` picks a free number; runs at once
got :2 and :3), so **Num Lock** and the clipboard are per display; **wineserver**: Wine finds a prefix's server by the
prefix folder (`/tmp/.wine-<uid>/server-<dev>-<inode>` of `pfx`: one per slot seen), and every `wineserver -k`/`-w` of
we-drive runs with its slot's `WINEPREFIX` (unit test: a fake wineserver logs only its slot's prefix); fsync's shared
memory is `/dev/shm/wine-<inode>-fsync` of the same folder (one per running slot seen; the inode alone, but every slot's
prefix sits beside its farm, which must be on the install's file system); **Documents/Warcraft III** (preferences, the Open list, Campaigns), Proton's
`pfx.lock`, the caches (`XDG_CACHE_HOME`) and `we-rofs.so` are per slot folder; the network namespace is each sandbox's
own (`--unshare-net`), so no port can clash; `$XDG_RUNTIME_DIR` holds only the slots' locks. Unit tests:
`we-slots.test.mjs`. **A/B** (slot 1 measured, slot 2 busy with an HD game view of TwistedMeadows, drags, held keys and
`--fps`; slot 0 ran another session's specs throughout, so "alone" means one other editor, not none): a settled view of
cliff.w3m (HD game view, `--look center` and `0,0,1500`) gave the same PNG bytes alone and in parallel (2 + 2 runs); an
animated one (HillsbradCreek, birds and fog) differs between any two runs: box means alone against alone within 0.34
per channel, alone against parallel within 0.75, mean absolute pixel difference 2.3 to 5.7 against 3.6 to 5.5. **`--fps`
is not parallel-safe**: HillsbradCreek's opening view changed 1.4 to 1.6 times a second alone (3 runs, 20 s each) and
0.8 to 0.9 with the second editor busy, the helper's grabs 53 against 45 a second: run it with `we-drive --alone`
(every slot's lock, taken in ascending order). File-diff specs: two we-compare runs started together with `--slot auto --slots 1,2` got slots 1 and 2 (slot 0
ran another session's specs too): camera-farz.json + nudge-keys-we.json (3 specs: a held `Right@600`, `--numlock on`,
number-pad nudges) and paste-centre.json + edge-group-nudge.json (4 specs: 1200 ms drags, 70 number-pad presses) all
MATCH (World Editor parts 267 s and 724 s). Parallel-safe: file-diff specs and pictures
of a settled view; a spec whose World Editor part times something (a frame rate, an animation) gets `"serial": true`:
we-compare runs it last on slot 0 with every slot's lock held (none is marked yet).

**Editor CPU** (branch we-cpu, 2026-11-19; slot 1, slot 0 busy with a full run throughout, so numbers carry its
contention; CPU is a user scope's cgroup over 20 s of `--sleep`, all of a run's processes: editor, Wine, Xvfb, node).
Cause: the editor redraws its views all the time, idle or not, through DXVK on Mesa's **lavapipe** (16 `llvmpipe`
threads at 50 to 70 % each), and every frame is CPU work: about 0.25 core-seconds a frame in SD, 0.6 in HD on the empty
map and about 6 on HillsbradCreek in HD (DXVK's HUD, `DXVK_HUD=fps,devinfo`: 16 fps HD empty, 1.5 to 1.9 HD
HillsbradCreek). The "52 a second" of earlier notes were the helper's grabs, not frames. The editor has no frame limit
of its own (WorldEditPreferences' [Video] holds Foliage, Particles, Texture Quality only). Measured (CPU %, frames or
picture changes a second):

| run | uncapped | `--frame-cap 10` | other |
|---|---|---|---|
| empty 64x64, HD | 1076, 16 fps | 891, 10 fps | cap 5: 468; cap 2: 217; `LP_NUM_THREADS=4` uncapped: 407 at 8 fps |
| empty 64x64, SD | 1024 | | cap 5: 126 |
| HillsbradCreek, SD | 778, 17.7 changes/s | 485, 10 | cap 10 with `LP_NUM_THREADS` 8: 440 (9.7), 4: 342 (7.7, below the cap); `PROTON_USE_XALIA=0`: 474 |
| HillsbradCreek, HD | 1103, 1.9 | 1092, 1.9 (below the cap) | `--renderer gpu` uncapped: **179, 15.5** |

What is default now: **`--frame-cap 10`** (DXVK_FRAME_RATE; `--frame-cap 0` or `W3PROJ_WE_FRAME_CAP=0` is the old
behaviour). It cuts SD by 40 to 85 % and HD on light maps; HD on a real map draws under 10 frames anyway, so there only
the GPU helps. Settled pictures are the same bytes (cliff.w3m: HD game view `--look center` and `0,0,1500`, SD the
same looks: 2 of 4 byte-identical, the other 2 differ only in the editor's yellow message lines in the view's bottom
left, which scroll with time; mad 0.01 and 0.81). **`--renderer gpu`** (opt-in; NVIDIA 595 presents into Xvfb,
which older notes said it couldn't): the same views are within the picture tolerance but not the same bytes (mad 2.05
and 2.73 HD, 0.41 SD: texture filtering noise all over, box means alike), so it isn't the default: earlier box-mean
numbers in this file are lavapipe's. --wait-ready prints `"render": {"renderer", "frameCap", "driver"}` (the driver from
the editor's /proc maps: "lavapipe" or "nvidia"). `--fps` counts at most the cap (it prints "frameCap"): use
`--frame-cap 0` for the editor's own rate. Not tried further: `--screen` (smaller views change every picture), Xvfb
with the NVIDIA GLX (Xvfb has no loadable GLX), a CPU quota per slot (it slows frames as fewer threads do, and
timing with them). **Specs** (we-compare `--slot 1`, camera-farz, paste-centre, minimap-real, nudge-keys-we: 9 specs,
a held key, 1200 ms drags, number-pad nudges, minimaps SD and HD): all OK in each of uncapped, cap 10 and gpu + cap 10;
the run's CPU (Studio included) 4493, 2082 and 1207 core-seconds, wall time 922, 886 and 913 s (the World Editor parts
683, 659, 635 s: their sleeps, not the frames, set the time). So a slot now averages about 2.3 cores over a spec run
instead of 4.9 (gpu 1.3): about 6 slots fit in 16 cores where 3 did, more with `--renderer gpu`; an HD view of a real
map still takes about 11 cores on lavapipe whatever the cap.

**Which renderer we-compare uses** (branch we-gpu-default, 2026-11-19; the user's decision): we-drive's default stays
the software renderer (lavapipe, frame cap 10), so measurements stay comparable; the GPU is used where it pays. we-compare
passes `--renderer` to each we-drive process: `--renderer auto` (default, or `W3PROJ_WE_RENDERER`) picks **gpu** for specs
of mode hd or de and for every process of a *full run* (the whole `tests/we-compare` folder named, or `--shard i/n`),
else software. `--renderer software|gpu` on we-compare (or the env) wins over everything. A spec's `we.renderer`
(`"software"`, with `we.why` as the comment) forces its own renderer under auto: set it on specs whose result is a
picture of a settled view measured on lavapipe (minimap blocks at a tight tolerance), because GPU pictures differ by
texture filtering noise (mean diff up to about 2.7). File-diff specs run on whichever. Specs with another renderer are
another we-drive process (`weGroupKey`). No hardware Vulkan driver (we-drive's skip message): the process is
started again with software, one printed line, never a failure (an explicit `--renderer gpu` still reports the skip).
