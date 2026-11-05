<!--
summary: Custom spells in JASS: base abilities, events, direction, several casts at once, dummy units, leaks.

Sources of the spells guide. All search excerpts, partly from old pages:
  Hive, Beginning JASS Tutorial Series: https://www.hiveworkshop.com/threads/beginning-jass-tutorial-series.30765/
  Hive, Define MUI: https://www.hiveworkshop.com/threads/define-mui.222614/
  TheHelper, Multi-Unit Instanceability: https://www.thehelper.net/threads/spells-multi-unit-instanceability-mui.43535/
  TheHelper, Dummy Casters: https://world-editor-tutorials.thehelper.net/cat_usersubmit.php?view=26751
  TheHelper, Memory Leaks and Custom Scripts: https://world-editor-tutorials.thehelper.net/cat_usersubmit.php?view=27219
  wc3sear.ch, Dummy Units Tutorial: https://www.wc3sear.ch/thread/12489
From general knowledge, not checked against those pages or the game: how to build a spell, the
Channel base, effect against cast events, radians, SetUnitX at the map's edge, the step time, damage
and balance. The hero test here showed the facing problem.
-->

# Custom spells

Most custom spells are a harmless base ability that does the casting, plus a script that does the work.
None of this can be tested in the game from here: say so, and ask the user to play it.

## How to build one

1. create_object: an ability based on one with no effect of its own. Channel (ANcl) is the usual choice, as
   its target type, cast time and icon can all be set. Search with list_objects.
2. A trigger on EVENT_PLAYER_UNIT_SPELL_EFFECT, with create_script_trigger, that checks GetSpellAbilityId.
   Use the effect event, not the cast one: SPELL_CAST fires before mana is spent, so it can be dodged.
3. Read the event's values right away: GetTriggerUnit, GetSpellTargetX and GetSpellTargetY. They're gone
   after a wait, and timers don't have them. Store what later steps need.
4. build_script after each change. It checks grammar and types, not whether the spell works.

Use search_script_api for exact names, and search_game_files for effect models: Abilities\Spells and
Abilities\Weapons. Use read_game_file on the game's own scripts when unsure how something is called.

## Positions and direction

- Angles from Atan2 are in radians, unit facing in degrees. Mixing them up is the usual reason an effect goes
  the wrong way. To go from a unit towards a point: Atan2(ty - y, tx - x), then x + d * Cos(a), y + d * Sin(a).
- Start a missile from where the caster stands, plus a little distance forward. The caster's facing may not
  point at the target yet when the effect fires, so work the direction out from the target point.
- Don't use SetUnitX or SetUnitY outside the map's bounds: that can crash the game. Clamp to the playable
  area, or stop the missile there.
- SetUnitX and SetUnitY ignore pathing, which suits missiles; use IsTerrainPathable if it has to stop at walls.

## Several casts at once

A spell must work when several units cast it at the same time; that's called MUI. Test for it by giving it to
several units.

- Never keep a cast's data in a global. A second cast overwrites it.
- For something that takes time, make a timer per cast and store its data in a hashtable under
  GetHandleId of the timer, or use one timer over a list of running casts.
- Avoid TriggerSleepAction for timing: it's imprecise, and it loses the event's values.
- Moving things look smooth at about 0.03 seconds per step.

## Dummy units

A dummy is an invisible unit that carries a missile model or casts a real spell for you.

- Build it with create_object from a normal unit. Add Locust (Aloc), and Invulnerable (Avul) if needed. Clear
  its shadow, sight, food, and attacks; set a fitting movement type, and flying if its height or facing has to
  change. Model empty unless it shows the missile.
- To let one cast a real spell, it needs the ability, enough mana or a cost of 0, no cast time, and a target
  it's allowed to hit. If it doesn't cast, test with another spell to see which part fails.
- Give each one an end: UnitApplyTimedLife with BTLF, or remove it in the script. Forgotten dummies pile up and
  slow the game.
- Give it the caster's owner, so kills and damage count for the right player.
- A unit with two abilities based on the same one may cast the wrong one. Use different bases.

## Hitting things

- Find targets with GroupEnumUnitsInRange. Filter out dead units, allies, structures and flyers as needed.
  IsUnitEnemy takes the owner of the caster.
- Deal damage with UnitDamageTarget from the caster, so kills give experience and gold, and armour counts.
- A missile that passes over units must remember whom it already hit, with a group of its own, or it hits
  them each step.

## Leaks and cleanup

Small leaks add up: two a second are 7,200 an hour.

- DestroyGroup, DestroyTimer, and RemoveLocation or better plain x and y instead of locations.
- DestroyEffect after AddSpecialEffect. It still plays out.
- Set local variables of handle types to null at the end of a function.
- Every path out of a timer's function must clean up, not only the usual one.

## Numbers and balance

Tooltips must say what the spell does, with its real numbers per level. Use the ability's own fields for cost,
cooldown and range. Read damage from a level-based formula, not one fixed number.

## Testing checklist for the user

- Cast at close range, long range, at the map's edge, and into a cliff or trees.
- Cast from several units at once, and cast again while it runs.
- Kill the caster while it runs.
- Does it hit allies, buildings or flyers when it shouldn't?
