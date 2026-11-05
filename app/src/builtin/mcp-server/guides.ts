// Guides an AI reads before a job that needs more than the tools' descriptions, in our own words.
// Melee numbers were measured on six ladder 1v1 maps (Autumn Leaves, Echo Isles, Hammerfall, Last
// Refuge, Northern Isles, Terenas Stand: 115 camps), its rules from Blizzard's designer note on
// competitive melee maps and community reviews. Terrain numbers were measured on those and Twisted
// Meadows and Turtle Rock; its methods and those of the spell guide come from community tutorials.

// Sources of the melee guide. Numbers: measured on the six maps above, so not from these pages.
// Read in full:
//   Blizzard, Competitive Melee Map Making Designer Note: http://classic.battle.net/mod/dev/melee.shtml
//     (camp colours, drop table, camp mode, neutral buildings, ramps, tileset creeps)
//   warcraft3.info, The Pathing Structure of Maps: https://warcraft3.info/articles/423 (open or structured)
//   TheHelper, Melee Maps like the Professionals: https://world-editor-tutorials.thehelper.net/cat_usersubmit.php?view=19935
// Search excerpts only (Hive Workshop refuses automated reading):
//   Hive, Competitive Melee Map: https://www.hiveworkshop.com/threads/competitive-melee-map.252987/
//   Hive, How to create Melee Maps: https://www.hiveworkshop.com/threads/how-to-create-melee-maps.187652/
//   Hive, Melee Mapping Contest #3: https://www.hiveworkshop.com/threads/melee-mapping-contest-3-4-vs-4.310613/page-3
//   warcraft3.info, Last Refuge Review: https://warcraft3.info/articles/353 (creeping directions)
//   Warcraft 3 Gym, one camp into expansion: https://warcraft-gym.com/learn/guide/archmage-first-one-creep-camp-into-expansion
// Our own judgement, not sourced: 800 as the distance from routes, width 4 for main ramps.
const MELEE = `# Melee maps

A melee map is judged in play, and most of what makes one good isn't symmetry. Fair is the minimum:
the map also has to give players choices about where to go, what to fight and when to expand.

Numbers here are measured on six ladder 1v1 maps unless they say otherwise. Treat a value far outside
a range as a mistake to explain, not as a style. Sizes are for 1v1; scale the counts for more players.

## The mistakes to avoid first

- Camps beside the routes. A scout walking across the map must not wake anything. Camps go in corners,
  pockets and dead ends, off the way. Of the measured camps 94% are over 800 from the straight line
  between the bases, typically 2,800.
- Camps near the base. The nearest camp to a start location is 1,750 to 2,250 away, usually about
  2,150, and nothing is closer. A town hall has to be able to stand and build without a fight.
- A flat map. Paths through trees on flat ground are dull however fair. See Terrain.
- All areas looking alike. Each part of the map should be recognisable at a glance.
- Creeps left on their normal setting. Everything except mine guards goes on Camp mode (see Creeps).

## Size and layout

- Playable size 84 × 84 to 108 × 88. Small is better; smaller maps get played more.
- Bases opposite each other, 10,000 to 12,000 apart in a straight line.
- Distances between each start and its mines, trees, shops and expansions must match. Rotating one half
  by 180° around the map's centre gives that, and (x, y) becomes (-x, -y) on a map centred on 0.
- Give every start room for a whole base, and the same number of ways in. Test it with place_objects
  and dryRun, using a town hall and some large buildings.
- Offer more than one way between the bases, so a player can flank or dodge an army. Camps, distance and
  creep strength alone can shape a good open map (Northern Isles, Echo Isles); a more structured one
  uses high ground and narrow passages to steer traffic (Terenas Stand, Hammerfall). Pick one on purpose.
- Don't send every creeping route inwards towards the middle: a player creeping that way is easy to
  harass from everywhere. Some camps should lead away, towards the edge and behind the base.

## Gold

- 5 or 6 mines on a 1v1 map, one for each start and 3 or 4 expansions.
- A start's mine is 770 to 780 from the start location, centre to centre. Every measured map is within
  that, so use it exactly. One mine per start: two near a start hurts Night Elves.
- Starting mines have 12,500 gold. Expansions have 9,000 to 13,500.
- The nearest expansion is 3,800 to 5,800 from the start, usually about 5,300.
- Further or harder expansions should pay better than easy ones, never worse.
- Every expansion is guarded; see the mine guards under Creeps.

## Lumber

- The nearest tree is 550 to 690 from the start location, and 36 to 52 trees stand within 1,000.
- Both must match between the starts.
- 1,200 to 2,700 trees on a map, usually as solid walls that shape the map, not scattered singles.

## Neutral buildings

- Pick two or three kinds, not all of them, and share them out evenly.
- Usual: one Tavern (ntav) near the middle, 1 or 2 Goblin Merchants (ngme), 1 or 2 Mercenary Camps
  (nmer, or the tileset's own), sometimes a Goblin Laboratory (ngad) or Marketplace (nmrk).
- A Mercenary Camp between a base and its expansion helps Human players, who rely on expanding early.
- Fountains change games: only in the middle, the same distance from everyone, never near a base.
- Owner is Neutral Passive, player 28, for mines and neutral buildings alike.
- Put trees or camps around shops so a player has to fight to shop safely, not walk straight in.

## Creeps

18 to 20 camps on a map, 66 to 84 creeps, with 2 to 6 creeps in each, usually 4.
Owner is Neutral Hostile, player 25.

Colour by the sum of the creeps' levels:

| Colour | Total level | Share of camps | Use |
| --- | --- | --- | --- |
| Green | 1 to 9 | 37% | Early levels, near the bases |
| Orange | 10 to 19 | 57% | Most of the map, shops, mines |
| Red | 20 and up | 7% | Far away; rarely over 23, and beatable |

By distance from the nearest start, the typical total level:

| Distance | Camps | Typical level |
| --- | --- | --- |
| Under 2,500 | 16% | 9 |
| 2,500 to 4,000 | 21% | 13 |
| 4,000 to 5,500 | 33% | 13 |
| Over 5,500 | 30% | 16 |

- Every map has at least one orange and two green camps within reach of each base early on.
- A camp between a base and its expansion works best as a hard green or easy orange, since it's taken on
  the way. Bigger ones cost too much time.
- Camp mode: set camp true on every creep that doesn't guard a mine. All 92 measured camps away from
  mines are on it, because creeps on it stay put until someone comes close.
- Mine guards: leave camp off. None of the 23 measured guards is wholly on Camp mode. They have to attack
  whatever comes near, or a player could expand or build towers next to them unopposed. They total 11
  to 24, usually 14. Keep them close to the mine, under 750.
- Creep sight is 500 to 800, usually 600. Keep every route at least 800 from any camp that isn't meant
  to be walked into.
- The game's own numbers: a creep that wakes calls others within 600. Placing a building alerts creeps
  within 600, and using a shop alerts those within 900, which is how a shop gets guarded by a nearby camp.
- The strongest creep is usually level 5, sometimes up to 9. No creep of level 6 or above in the first
  camps a player can reach.
- Mix melee, ranged and casters, and let each camp be able to hit air. An all-ranged camp favours Human,
  and an all-air one Night Elf.
- Use the tileset's usual creeps, unless another set suits a theme.

## Item drops

Give drops with drops on place_objects. Each entry drops one random item of that level and kind, so the
item changes per game and stays within what the game allows. Never hand-pick a specific item.

| Total level | Drops |
| --- | --- |
| 3 to 8 | Level 1 permanent or powerup |
| 8 to 11 | Level 2 permanent, charged or powerup |
| 11 to 14 | Level 1 permanent or powerup, and level 2 permanent, charged or powerup |
| 14 to 17 | Level 1 permanent or powerup, and level 3 permanent or charged |
| 18 to 21 | Level 2 permanent, charged or powerup, and level 4 permanent or charged |
| 21 to 23 | Level 2 permanent, charged or powerup, and level 5 permanent or charged |
| 23 to 26 | Level 2 permanent, charged or powerup, and level 6 permanent or charged |

Powerups exist at levels 1 and 2 only. Give the best drop to the camp's strongest creep, so nobody can
snipe it from a weak one and run. Spread two drops over two creeps, so players finish the fight.

## Terrain

Read the terrain guide too, for how to make all this look good. This part is about what a melee map needs.

- Use cliffs or water to block a path for good: trees can be cut down, so never rely on a tree wall by a base.
- Cliffs fill about 13% of the tiles (10 to 20%), with about 6 levels in use. Water that shows covers 11
  to 64%, usually about 30%. An all-open map like Echo Isles has almost no cliffs (0.1%), and gets its
  shape from water and trees instead.
- Use set_cliff_level for plateaus, cliff walls and pockets, and set_water for lakes and rivers. Those
  pockets are where the camps go.
- High ground needs ramps wide enough for an army to walk up, placed some way from the base so attackers
  can reach the top before fighting. Use set_ramp, the same on both sides. There's no measured width
  here: a narrow ramp makes attacks hard and less fun, so start from width 4 on main routes.
- 5 or 6 ground tiles, with one covering 40 to 70%. Paint roads, worn ground around bases, and grass or
  rock where nobody walks.
- 1,700 to 6,300 doodads and destructables, of which 340 to 3,400 are decoration. Put detail where the
  camera spends time: bases, shops, camps and crossroads, not spread evenly.
- Give each area its own landmark, like a ruin, an old camp or a broken bridge, built from several objects.

## Order of work

1. Plan one half on paper first: bases, mines, ways between them, pockets for camps.
2. terrain_info, then set_cliff_level and set_water, so the shape comes first. Use begin_edit.
3. Trees as walls, with scatter_objects or fill_rows. reserve_area first for bases, mines and shops.
4. paint_path and paint_terrain for roads and ground.
5. Start locations (sloc), mines, shops. Then camps, then decoration last.
6. Rotate each part to the other side as you go, not at the end.

## Checks before calling it finished

- check_melee, and read its accuracy notes. All six ladder maps pass it without errors, so an error is
  worth fixing. Its warnings about camps on Camp mode are the worst case: those maps have them too.
- check_path between the bases, and from each base to every mine and shop, for units of size 32 and 72.
- check_route along the main routes, then compare with list_placed: nothing hostile within 800 of a
  route unless meant.
- find_pockets: no walkable ground cut off by accident.
- Measure from each start: nearest camp, mine distance, nearest tree, trees within 1,000. They must match
  and sit in the ranges above.
- list_problems and build_script.
- terrain_screenshot of the whole map with overlay pathing, then close-ups of the bases.
- Say plainly that nobody has played it. None of this replaces a match.
`;

// Sources of the terrain guide. Numbers: measured on the eight maps above, so not from these pages.
// Read in full:
//   TheHelper, Melee Maps like the Professionals: https://world-editor-tutorials.thehelper.net/cat_usersubmit.php?view=19935
//     (doodads with a reason, gameplay first, cliffs or water to block paths)
// Search excerpts only:
//   Hive, The Ultimate Beginners Terrain Tutorial: https://www.hiveworkshop.com/threads/the-ultimate-beginners-terrain-tutorial.35233/
//   Hive, Advanced Terraining Tutorial: https://www.hiveworkshop.com/threads/advanced-terraining-tutorial.203428/
//   Hive, 101 Do's and Don'ts of Terraining: https://www.hiveworkshop.com/threads/101-dos-and-donts-of-terraining.33437/
//   Hive, iPeez's Complete Terraining Tutorial: https://www.hiveworkshop.com/threads/ipeezs-complete-terraing-tutorial-v1-0.114203/
//   Hive, Terraining Tut. - Forests: https://www.hiveworkshop.com/threads/terraining-tut-forests.7391/
//   TheHelper, Terraining - Advanced: https://www.thehelper.net/threads/terraining-advanced.25773/
//   TheHelper, Terrain Transitions: https://world-editor-tutorials.thehelper.net/cat_usersubmit.php?view=77002
//   Elil's Terrain FAQ: https://www.elilz.com/terrain.html
// Our own judgement, not sourced: the Landmarks section, and how the tips map onto the tools.
const TERRAIN = `# Terrain that looks good

Good terrain looks untidy on purpose. An AI's first attempt tends to be clean: flat ground, smooth patches
of one tile, evenly spread objects of one size. That reads as artificial at once.

Numbers are measured on eight ladder maps. They're there to show how far from tidy a good map is.

## Work in this order

1. Shape: cliffs and water, then the height of the ground.
2. Tiles, by what the ground is and how it's used.
3. Big things: tree walls, large rocks, buildings, ruins.
4. Small things last: shrubs, flowers, stones, to fill gaps and hide seams.

Going in another order means redoing work: objects follow the ground, but a tile plan doesn't survive new
cliffs. Look at each stage with terrain_screenshot before the next, using view angled or low, not only top.

## Height

- Flat ground looks dead. Only about 8% of the corners are at plain height on these maps, 30% at most.
- Heights on a map span about 300 to 600, on top of the cliff levels. Hills have to be gentle: both a flat
  map and a jagged one look bad.
- With sculpt_terrain, many small overlapping raises and lowers in different sizes, then smooth where units
  walk. One big hill over a whole area looks like a blister. Raise under trees and beside cliffs.
- Rock tiles want raised ground, because rock isn't flat. Dirt suits low ground, grass normal ground, rock
  high ground.
- Keep ground level where a base has to stand; buildings need room.

## Tiles

- Natural ground uses at least 3 tiles. These maps use 6 to 12, with one covering 40 to 70%.
- Edges must be ragged. A fifth to a third of neighbouring corners have different tiles, and the typical
  patch is a single corner, thousands of times over. A smooth outline around a patch is the clearest sign
  of a machine. Avoid straight lines between tiles.
- With paint_terrain, use a high edge, and paint in layers: a wide patch, then smaller and smaller ones over
  its rim, with a different seed each time.
- Blend in steps instead of putting thick grass next to bare dirt: dirt, then grassy dirt, then grass.
- Tiles tell what happens there. Worn dirt on roads, around buildings and at crossroads, with grassy dirt
  along it. Dirt and grassy dirt near water, grass away from it, rock on cliff tops.
- Roads aren't lines. paint_path with several points, a frayed edge and a width that suits the traffic.
- Tiles from another tileset can work in small amounts, as many ladder maps do. Don't mix two totally
  different looks.

## Objects

- Variety matters more than number. These maps use 14 to 104 kinds of doodad, usually about 45.
- Nearly 90% of objects vary in size, between 0.8 and 1.2 of normal. Keep the random size and variation:
  scatter_objects does that, and takes scaleRange. Vary the facing too.
- Trees stand in solid walls, 128 apart. Use fill_rows with a spacing of 128 for that. Most of a map's trees
  are one kind, with a second one as an accent; a forest of equal mixes looks wrong.
- Bare singles look lost. Set a rock beside a tree, and scrub and vines around rocks and trees.
- Fill the border too. Past the playable map is the backdrop players see at the edge: 7 of 8 ladder maps
  have trees and doodads out there, up to a fifth of all they have. Units and items can't stand there.
- Don't overfill. Packing an area looks terrible and slows the game. Leave open ground where units fight.
- Everything should have a reason to be there: treasure beside a Goblin Merchant, cages by dangerous creeps,
  no torches in the snow, no cage in the middle of nowhere. Keep to the tileset's theme.
- Doodads hide seams, so use them where tiles or cliffs meet awkwardly.
- Use list_objects with tileset map to see what suits the tileset, and terrain_screenshot to see the result.

## Landmarks

Each part of the map should have something to remember it by, so players can say where things happened:

- Build a landmark from several objects: a ruin with rubble, a camp with tents and a fire, a wrecked cart.
- Give areas different ground and growth, so that one corner is rocky and another marshy.
- Vary the forms: a straight wall of trees is dull, a curving edge with gaps and clumps isn't.

## Gameplay comes first

Never make a map worse to play for the sake of its looks. Block paths permanently with cliffs or water, not
with trees, since trees can be cut down. Doodads that block pathing change routes: use check_path after
decorating, and overlay pathing on terrain_screenshot to see what's blocked.

## Checks

- terrain_screenshot with view low at a few places: does the horizon look alive?
- terrain_screenshot with overlay heights: is the ground uneven everywhere it should be?
- Is any patch edge straight or smooth? Is any area just one tile?
- Does each area look different from the others?
`;

// Sources of the spells guide. All search excerpts, partly from old pages:
//   Hive, Beginning JASS Tutorial Series: https://www.hiveworkshop.com/threads/beginning-jass-tutorial-series.30765/
//   Hive, Define MUI: https://www.hiveworkshop.com/threads/define-mui.222614/
//   TheHelper, Multi-Unit Instanceability: https://www.thehelper.net/threads/spells-multi-unit-instanceability-mui.43535/
//   TheHelper, Dummy Casters: https://world-editor-tutorials.thehelper.net/cat_usersubmit.php?view=26751
//   TheHelper, Memory Leaks and Custom Scripts: https://world-editor-tutorials.thehelper.net/cat_usersubmit.php?view=27219
//   wc3sear.ch, Dummy Units Tutorial: https://www.wc3sear.ch/thread/12489
// From general knowledge, not checked against those pages or the game: how to build a spell, the
// Channel base, effect against cast events, radians, SetUnitX at the map's edge, the step time, damage
// and balance. The hero test here showed the facing problem.
const SPELLS = `# Custom spells

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

Use search_script_api for exact names, and search_game_files for effect models: Abilities\\Spells and
Abilities\\Weapons. Use read_game_file on the game's own scripts when unsure how something is called.

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
`;

export const GUIDES: Record<string, { summary: string; text: string }> = {
  terrain: { summary: "Making terrain look good: height, ground tiles, objects and landmarks, with numbers from real maps. For any map.", text: TERRAIN },
  spells: { summary: "Custom spells in JASS: base abilities, events, direction, several casts at once, dummy units, leaks.", text: SPELLS },
  melee: { summary: "Building or judging a melee map: layout, gold, lumber, shops, creep camps, drops, terrain, with numbers from real ladder maps.", text: MELEE },
};
