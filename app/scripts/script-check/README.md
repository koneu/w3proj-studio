# Script generation checks

Compare `lib/script` output with the World Editor's own `war3map.j` of unpacked maps.

`node tests/gate.mjs corpus` runs it all. Alone, from `app/`:

    node scripts/script-check/run.mjs [--update-baseline] [--fresh]

That extracts the game's maps and tables into `target/script-check` (once per game build), runs the
checks below and holds the counts against `tests/script-baseline.json`: they may rise, never fall.
`W3PROJ_GAME` is the install folder, `W3PROJ_BIN` the `w3proj` binary.

To look at differences, run a check by hand from `target/script-check`:

    node --experimental-transform-types --import ../../app/scripts/script-check/tsregister.mjs ../../app/scripts/script-check/sections.mts <repo>/app/src/lib "<Section>" <diffs>
    node --experimental-transform-types --import ../../app/scripts/script-check/tsregister.mjs ../../app/scripts/script-check/functions.mts <repo>/app/src/lib <diffs> [name filter]

`sections.mts` prints identical sections per banner title; `functions.mts` compares the
trigger functions one by one and lists the most common first differences.

It also reports what must stay silent on maps the World Editor made: `lib/script/guard.ts`
(`guard:`, scripts that would be kept) and the Problems view's trigger references and Lua check
(`problems:`, dead references in the game's own maps; the count may only fall).

`sections.mts` also counts whole files that come out identical, `(whole file)`; pass that as the
section to see where a file whose sections all match still differs. Sound durations come from the
World Editor's script (`scriptSoundDurations`), as the app takes them when it can't read the sound files.
The map's custom script header is the section `Custom Script Code (header)`: the World Editor writes
it under a second banner after the objects.

## JASS checker (`lib/jass/check.ts`)

`jass-valid.mts` checks common.j, Blizzard.j and every map's war3map.j (valid JASS: any report is
a false positive); `jass-mistakes.mts` has deliberate mistakes that must be reported and correct
code that must not.
