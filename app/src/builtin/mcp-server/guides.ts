// Guides an AI reads before a job that needs more than the tools' descriptions. Numbers marked as
// measured come from six ladder 1v1 maps (Autumn Leaves, Echo Isles, Hammerfall, Last Refuge,
// Northern Isles, Terenas Stand: 115 camps); the rules from Blizzard's designer note on competitive
// melee maps and community reviews, in our own words.

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

export const GUIDES: Record<string, { summary: string; text: string }> = {
  melee: { summary: "Building or judging a melee map: layout, gold, lumber, shops, creep camps, drops, terrain, with numbers from real ladder maps.", text: MELEE },
};
