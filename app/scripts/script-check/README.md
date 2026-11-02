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
`ItemData.slk` (from `UI\` and `Units\`) and `abil/*.txt` (the `Units\*AbilityFunc.txt` files).
