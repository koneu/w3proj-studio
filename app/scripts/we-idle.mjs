// "Wait for the condition, not the clock" for we-drive: how long the editor needs after a key, a click or a menu.
//
// waitQuiet() polls the editor's observable state and returns once it has stood still for `quietMs`:
//   - the window set (titles and sizes): a window opening, closing or changing its title is activity;
//   - a picture of every window but the main one (md5 from the X helper's `stats`): a list filling is activity. The
//     main window's terrain view redraws all the time (measured 52 changes a second in SD with the day fixed).
// It never returns before `minMs` (the editor reads the input only some ms later: right after a click the screen is
// still the old one) and stops with an error naming what it waited for after `timeoutMs`.
//
// The editor's CPU doesn't work as the quiet signal: measured on 2026-11-19 (SD, fixed day, the map ready and idle),
// the editor and its Wine processes took 9 cores' worth of CPU without a pause (software GL redraws all the time), so
// "CPU below a threshold" never came. Only what is on the screen tells.

/**
 * `sample()` gives `{ key, pic, ready }` (the window set as text, the picture's hash, false while the window waited for
 * isn't there: the time only counts from when it is); `clock` is { now, sleep }. Resolves
 * with `{ ms, polls }`. Rejects with `Error("timed out … waiting for <what>")` naming what kept changing.
 */
export async function waitQuiet({ sample, clock, what = "the editor to go quiet", minMs = 150, quietMs = 400, pollMs = 50, timeoutMs = 30000 }) {
  const t0 = clock.now();
  let prev = sample(), quietSince = clock.now(), polls = 1, changing = "";
  for (;;) {
    await clock.sleep(pollMs);
    const now = clock.now(), cur = sample();
    polls++;
    if (cur.ready === false) { quietSince = now; changing = "the window wasn't there yet"; } else if (cur.key !== prev.key || cur.pic !== prev.pic) {
      changing = cur.key !== prev.key ? `the windows (${cur.key})` : "the picture";
      quietSince = now;
    }
    prev = cur;
    if (now - quietSince >= quietMs && now - t0 >= minMs) return { ms: now - t0, polls };
    if (now - t0 >= timeoutMs) {
      throw new Error(`timed out after ${Math.round((now - t0) / 100) / 10} s waiting for ${what}: ${changing ? `${changing} was still changing ${now - quietSince} ms ago` : "no change seen, the quiet time was not reached"}`);
    }
  }
}
