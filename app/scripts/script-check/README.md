# Script generation checks

Compare `lib/script` output with the World Editor's own `war3map.j` of unpacked maps.

Setup (once), in a scratch folder:

- `ws/<n>/map/…`: maps unpacked with `w3proj unpack` (the game's maps work well: they carry
  the trigger data and the script the World Editor made from it).
- `TriggerData.txt`: `w3proj game cat "UI\TriggerData.txt" > TriggerData.txt`.
- `tsregister.mjs`: a Node loader that resolves extensionless `.ts` imports.

Run from that folder:

    node --experimental-transform-types --import ./tsregister.mjs <repo>/app/scripts/script-check/sections.mts <repo>/app/src/lib "<Section>" <diffs>
    node --experimental-transform-types --import ./tsregister.mjs <repo>/app/scripts/script-check/functions.mts <repo>/app/src/lib <diffs> [name filter]

`sections.mts` prints identical sections per banner title; `functions.mts` compares the
trigger functions one by one and lists the most common first differences.

Also needed in that folder for `sections.mts`: `WorldEditData.txt`, `UnitBalance.slk`,
`ItemData.slk`, `AbilityData.slk` (from `UI\` and `Units\`), `abil/*.txt` (the `Units\*AbilityFunc.txt`
files) and `soundinfo/*.slk` (the `UI\SoundInfo\*.slk` tables, for labelled sounds).

`sections.mts` also counts whole files that come out identical, `(whole file)`; pass that as the
section to see where a file whose sections all match still differs. Sound durations are compared
as 0 (they come from the sound files).

## JASS checker (`lib/jass/check.ts`)

Also needs `common.j` and `Blizzard.j` (`w3proj game cat "War3.w3mod:Scripts/common.j"`, …):

    node --experimental-transform-types --import ./tsregister.mjs <repo>/app/scripts/script-check/jass-valid.mts <repo>/app/src/lib [reports to show] [map]
    node --experimental-transform-types --import ./tsregister.mjs <repo>/app/scripts/script-check/jass-mistakes.mts <repo>/app/src/lib

`jass-valid.mts` checks common.j, Blizzard.j and every map's war3map.j (valid JASS: any report is
a false positive); `jass-mistakes.mts` has deliberate mistakes that must be reported and correct
code that must not.
