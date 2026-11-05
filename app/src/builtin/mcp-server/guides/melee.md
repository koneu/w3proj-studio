<!--
summary: Building or judging a melee map: layout, gold, lumber, shops, creep camps, drops, terrain, with numbers from real ladder maps.

Numbers were measured on six ladder 1v1 maps: Autumn Leaves, Echo Isles, Hammerfall, Last Refuge, Northern Isles and Terenas Stand (115 camps).

Sources of the melee guide. Numbers: measured on the six maps above, so not from these pages.
Read in full:
  Blizzard, Competitive Melee Map Making Designer Note: http://classic.battle.net/mod/dev/melee.shtml
    (camp colours, drop table, camp mode, neutral buildings, ramps, tileset creeps)
  warcraft3.info, The Pathing Structure of Maps: https://warcraft3.info/articles/423 (open or structured)
  TheHelper, Melee Maps like the Professionals: https://world-editor-tutorials.thehelper.net/cat_usersubmit.php?view=19935
Search excerpts only (Hive Workshop refuses automated reading):
  Hive, Competitive Melee Map: https://www.hiveworkshop.com/threads/competitive-melee-map.252987/
  Hive, How to create Melee Maps: https://www.hiveworkshop.com/threads/how-to-create-melee-maps.187652/
  Hive, Melee Mapping Contest #3: https://www.hiveworkshop.com/threads/melee-mapping-contest-3-4-vs-4.310613/page-3
  warcraft3.info, Last Refuge Review: https://warcraft3.info/articles/353 (creeping directions)
  Blizzard, Creep Basics: https://classic.battle.net/war3/neutral/creepbasics.shtml (read in full: how creeps behave)
  Warcraft 3 Gym, one camp into expansion: https://warcraft-gym.com/learn/guide/archmage-first-one-creep-camp-into-expansion
Our own judgement, not sourced: 800 as the distance from routes, width 4 for main ramps.
-->

# Melee maps

A melee map is judged in play, and most of what makes one good isn't symmetry. Fair is the minimum:
the map also has to give players choices about where to go, what to fight and when to expand.

## How to read this guide

A measured number isn't a rule. It says what six ladder 1v1 maps happen to do, and six maps is few. Four
kinds of statement are here, and they don't weigh the same:

- Game facts: how the game works, from its own files or Blizzard. These hold.
- Measured: what those six maps do, marked with a range. A start, not a law: a value outside one isn't wrong
  by itself, but you should be able to say why.
- Advice: from Blizzard's designers and community reviews.
- Rule of thumb: our own judgement, and marked so.

Goals always win over numbers: fair starts, real choices, and units that get where they should. Sizes are for
1v1; scale the counts for more players.

## The mistakes to avoid first

- Coordinates made up on the spot. Use find_spots with kind camp and mirror: it gives sheltered pockets that
  meet these rules, and you choose among them. Run it again after placing.
- Camps beside the routes. A scout walking across the map must not wake anything. Camps go in corners,
  pockets and dead ends, off the way. What wakes a camp is the creeps' real sight and whether they're on Camp
  mode, so test it: check_melee does, with routes that follow the pathing. Of the measured camps 94% are over
  800 from the straight line between the bases, typically 2,800.
- Camps near the base. The nearest camp to a start location is 1,750 to 2,250 away, usually about
  2,150, and nothing is closer. A town hall has to be able to stand and build without a fight.
- A flat map. Paths through trees on flat ground are dull however fair. See Terrain.
- The same map every time. Main base on a plateau with three ways to the enemy is a habit, not a design: none of
  the six ladder maps has its main base above the ordinary ground, and most have about two separate ways, some one.
- All areas looking alike. Each part of the map should be recognisable at a glance.
- Creeps left on their normal setting. Everything except mine guards goes on Camp mode (see Creeps).

## Size and layout

## Choosing a kind of map

Decide this first, since it decides everything after it:

| Kind | Shape | Examples |
| --- | --- | --- |
| Open | Many ways, little terrain in the way; camps and distances make the game | Northern Isles, Echo Isles |
| Semi-open | Terrain gives the map a shape, with some narrow places | Turtle Rock, Twisted Meadows |
| Structured | High ground and narrow passages steer the traffic | Last Refuge, Terenas Stand, Hammerfall |

- Measured: playable size 84 × 84 to 108 × 88. Small is better; Blizzard finds smaller maps get played more.
- Bases opposite each other, 10,000 to 12,000 apart in a straight line.
- Distances between each start and its mines, trees, shops and expansions must match. Rotating one half
  by 180° around the map's centre gives that, and (x, y) becomes (-x, -y) on a map centred on 0. Use mirror on
  place_objects, fill_rows, place_line and scatter_objects: it places both sides or neither. Without it, one
  skipped object breaks the symmetry unseen. Terrain and start locations have to be done for each side.
- Give every start room for a whole base, and the same number of ways in. Test it with place_objects
  and dryRun, using a town hall and some large buildings.
- Measured: main bases stand on the map's most common cliff level, on all six maps. High ground is for the middle
  or a side, not by default for the base.
- Measured, roughly: 1 to 4 separate ways between the bases, most often 2. A second way lets a player flank or
  dodge an army, but it should come from the map's idea, not from a rule.
- Compare real walking distances, not straight lines: a tree or cliff on one side can make the same distance
  a long detour. check_melee compares them.
- Don't send every creeping route inwards towards the middle: a player creeping that way is easy to
  harass from everywhere. Some camps should lead away, towards the edge and behind the base.

## Gold

- 5 or 6 mines on a 1v1 map, one for each start and 3 or 4 expansions.
- Measured: a start's mine is 771 to 781 from the start location, centre to centre. Start from 775. What
  matters is that a town hall fits beside it, and that both starts match. One mine per start: two near a start
  hurts Night Elves.
- Starting mines have 12,500 gold. Expansions have 9,000 to 13,500.
- The natural is the expansion a player takes first, and the one closest on foot. Measured on it:
  - 3,900 to 6,500 to walk from the start, usually about 5,600.
  - Nearly a straight walk: 1.02 to 1.10 times the straight line, on a way 480 to 670 wide. A natural isn't
    reached by a winding path or round a cliff.
  - The same cliff level as the main base, on all six maps, so no ramp between them.
  - To the side and forward: 23 to 54° off the direction of the enemy, usually about 45. Not behind the base.
  - Closer to the enemy than the main is: 56 to 82% of the walk from base to base. That's its risk.
- A second expansion is further again: 400 to 3,900 more on foot on these maps, so the first choice is clear.
- Further or harder expansions should pay better than easy ones, never worse.
- Every expansion is guarded; see the mine guards under Creeps.

## Lumber

- Measured: the nearest tree is 550 to 690 from the start location, and 36 to 52 trees stand within 1,000.
- Both starts must match. A count isn't the point: workers have to reach those trees, so look at the base in
  terrain_screenshot.
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

Measured: 18 to 20 camps on a map, 66 to 84 creeps, with 2 to 6 creeps in each, usually 4. Creeps stand at least
100 apart, all within 364 of the camp's middle. The nearest other camp is usually 1,900 away, and never under
1,047. The number of camps isn't a goal: what counts is that each player has a good order to take them in.

Game facts on how creeps behave:

- A camp acts as one unit. Attack one and all attack, and one that wakes calls others within 600.
- They only pursue a limited distance, then go home. They attack a new building started next to them, but
  leave finished ones alone: that's how building near a camp goes wrong. Placing a building alerts creeps within 600.
- Nearly all creeps sleep at night and don't notice units then, but some never sleep, and wake the others.
- Idle creeps ignore flyers.
- Level 6 and up have limited magic resistance: bad spells last less time on them, and some spells and items
  do nothing to them.
- Level 7 and up deal Chaos damage, go for injured units and heroes first, and attack buildings being built.

So two camps of equal total level can play very differently. Judge a camp by its creeps, not only its sum: one
level 7 isn't three level 3s for the player facing it.
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
- Camp mode is the placed unit's Target Acquisition Range set to Camp, which the map file stores as -2: set
  camp true on place_objects. All 92 measured camps away from mines use it for every creep. How far it
  shortens sight isn't in the game's files.
- Mine guards: leave camp off. None of the 23 measured guards is wholly on Camp mode. They have to attack
  whatever comes near, or a player could expand or build towers next to them unopposed. They total 11
  to 24, usually 14. Keep them close to the mine, under 750.
- Creep sight is 500 to 800, usually 600, from the game's data, per creep. Rule of thumb, ours and not the game's:
  800 from routes is a safe margin. A camp closer than that may be fine, so test it with check_melee.
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

## Paths

- Every way in the map should be wide enough for an army, or not exist. Stray little paths between trees look
  like a mistake, and trap units. Narrow strips are only 1.3 to 3.2% of the walkable ground on ladder maps.
- The widest way to a camp is usually 480, and hardly ever under 224. Players fight there with a whole group.
- Close a gap with trees or widen it; don't leave it in between. A camp isn't reached through a crack.

## Terrain

Read the terrain guide too, for how to make all this look good. This part is about what a melee map needs.

- Use cliffs or water to block a path for good: trees can be cut down, so never rely on a tree wall by a base.
- Measured, and only to show how much terrain good maps have: cliffs fill about 13% of the tiles, with about 6
  levels in use, and water that shows covers 11 to 64%, usually about 30%. An open map like Echo Isles has
  almost no cliffs (0.1%) and gets its shape from water and trees. Terrain should do a job, not reach a share.
- Use set_cliff_level for plateaus, cliff walls and pockets, and set_water for lakes and rivers. Those
  pockets are where the camps go.
- High ground needs ramps wide enough for an army to walk up, placed some way from the base so attackers
  can reach the top before fighting. Use set_ramp, the same on both sides. Rule of thumb: width 4 on main routes.
  Nothing here measures it, and only playing shows whether an army gets up.
- Paint roads, worn ground around bases, and grass or rock where nobody walks. Put detail where the camera
  spends time: bases, shops, camps and crossroads, not spread evenly.
- Give each area its own landmark, like a ruin, an old camp or a broken bridge, built from several objects.

## When a check fails

Fix that one thing, then run the check again. Don't rebuild what passed. Moving something can break what
passed before, so after moving camps or trees run check_melee and check_path again.

## When a rule can't be met

Say so instead of quietly bending it. In order: move the object along the edge of its pocket, then shrink or
reshape what's in the way with cliffs or trees, then change that part of the plan on both sides. Don't give
one player a worse deal to keep a number. Numbers outside the measured ranges need a reason you can state.

## Order of work

1. Plan one half on paper first: bases, mines, ways between them, pockets for camps.
2. terrain_info, then set_cliff_level and set_water, so the shape comes first.
3. Trees as walls, with scatter_objects or fill_rows. reserve_area first for bases, mines and shops.
4. paint_path and paint_terrain for roads and ground.
5. Start locations (sloc), mines, shops. Then camps, then decoration last.
6. Rotate each part to the other side as you go, not at the end.

## Checks before calling it finished

- check_melee, and follow each finding's fix. Read its accuracy notes. All six ladder maps pass it without errors, so an error is
  worth fixing. Its warnings about camps on Camp mode are the worst case: those maps have them too.
- check_path between the bases, and from each base to every mine and shop, for units of size 32 and 72.
- check_route along the main routes, then compare with list_placed: nothing hostile within 800 of a
  route unless meant.
- find_pockets: no walkable ground cut off by accident.
- Measure from each start: nearest camp, mine distance, nearest tree, trees within 1,000. They must match
  and sit in the ranges above.
- list_problems and build_script.
- terrain_screenshot of the whole map with overlay pathing, then close-ups of the bases.
- Say plainly what wasn't tested. Passing checks means it can be played, not that it's good: symmetric and fair
  isn't interesting, and only matches show how it plays. Ask for one, with both starts, against other races if possible.
