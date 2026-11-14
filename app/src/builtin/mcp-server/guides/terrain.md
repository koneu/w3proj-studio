<!--
summary: Making terrain look good: height, ground tiles, objects and landmarks, with numbers from real maps. For any map.

Numbers were measured on those six ladder maps, Twisted Meadows and Turtle Rock.

Sources of the terrain guide. Numbers: measured on the eight maps above, so not from these pages.
Read in full:
  TheHelper, Melee Maps like the Professionals: https://world-editor-tutorials.thehelper.net/cat_usersubmit.php?view=19935
    (doodads with a reason, gameplay first, cliffs or water to block paths)
Search excerpts only:
  Hive, The Ultimate Beginners Terrain Tutorial: https://www.hiveworkshop.com/threads/the-ultimate-beginners-terrain-tutorial.35233/
  Hive, Advanced Terraining Tutorial: https://www.hiveworkshop.com/threads/advanced-terraining-tutorial.203428/
  Hive, 101 Do's and Don'ts of Terraining: https://www.hiveworkshop.com/threads/101-dos-and-donts-of-terraining.33437/
  Hive, iPeez's Complete Terraining Tutorial: https://www.hiveworkshop.com/threads/ipeezs-complete-terraing-tutorial-v1-0.114203/
  Hive, Terraining Tut. - Forests: https://www.hiveworkshop.com/threads/terraining-tut-forests.7391/
  TheHelper, Terraining - Advanced: https://www.thehelper.net/threads/terraining-advanced.25773/
  TheHelper, Terrain Transitions: https://world-editor-tutorials.thehelper.net/cat_usersubmit.php?view=77002
  Elil's Terrain FAQ: https://www.elilz.com/terrain.html
Our own judgement, not sourced: the Landmarks section, and how the tips map onto the tools.
-->

# Terrain that looks good

Good terrain looks untidy on purpose. An AI's first attempt tends to be clean: flat ground, smooth patches
of one tile, evenly spread objects of one size. That reads as artificial at once.

Numbers are measured on eight ladder maps. They show how far from tidy a good map is; they aren't targets, and
reaching one doesn't make a map good. A thousand well-placed objects beat five thousand scattered ones.

Terrain also has a job: it tells players where they can go. A road should stand out from the ground beside it, a
camp should be visible as a place, a cliff should say where movement stops, and an expansion should look open.

## Work in this order

1. Shape: cliffs and water, then the height of the ground.
2. Tiles, by what the ground is and how it's used.
3. Structure: tree walls, large rocks, water's edge, big ruins.
4. Regions: what makes each area its own, like its growth, landmarks and buildings.
5. Detail last: shrubs, flowers, stones, to fill gaps and hide seams.

Going in another order means redoing work: objects follow the ground, but a tile plan doesn't survive new
cliffs. Look at each stage with terrain_screenshot before the next, using view angled or low, not only top.

## Height

- Flat ground looks dead. Only about 8% of the corners are at plain height on these maps, 30% at most.
- Heights on a map span about 300 to 600, on top of the cliff levels. Hills have to be gentle: both a flat
  map and a jagged one look bad.
- Start with sculpt_terrain mode roughen on the whole map, then add hills with raise and lower in different
  sizes, and smooth where units walk. One big hill over an area looks like a blister. Raise under trees and
  beside cliffs.
- Rock tiles want raised ground, because rock isn't flat. Dirt suits low ground, grass normal ground, rock
  high ground.
- Keep ground level where a base has to stand; buildings need room.

## Water

- Most water on real maps has no cliff round it: on Echo Isles 1,588 of 1,604 water edges are on one cliff
  level, with the ground sloping under the surface. Corners at the bank are about 20 deep.
- Units walk through water up to about 52 deep. Use set_water with mode ford for what people cross, and lake
  for water with a deep middle. Rivers can run at any angle with points.
- shallow and deep put a cliff all round the water, so units can't get in without a ramp. That suits a sunken
  pool or a moat, not a river to wade through.
- Run check_path after any water: it can split a map in two.

## Cliffs

- A tileset has two kinds of cliff, usually dirt and grass, and only those two ground tiles have one. Other
  ground beside a cliff doesn't change it, so a map that never chooses gets one look everywhere.
- Mix them with set_cliff_type: grass cliffs where a meadow ends, dirt ones in worn or rocky places. It
  takes any tileset's cliffs, which can make a corner of the map feel different. Keep that to a few.

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
  Doodads and destructables can go anywhere on the map, outside the camera bounds too.
- Don't overfill. Packing an area looks terrible and slows the game. Leave open ground where units fight.
- Everything should have a reason to be there: treasure beside a Goblin Merchant, cages by dangerous creeps,
  no torches in the snow, no cage in the middle of nowhere. Keep to the tileset's theme.
- Doodads hide seams, so use them where tiles or cliffs meet awkwardly.
- Use list_objects with tileset map to see what suits the tileset, and terrain_screenshot to see the result.
- Atmosphere is not terrain but sets the mood: set_sky changes light, fog, water tint and the terrain view's sky
  model (reply lists what changed; a wrong name gets the choices), set_weather puts rain, snow or wind over the
  whole map, or over one region (add_region first). Use weather sparingly and in a region where it belongs.

## Landmarks

Each part of the map should have something to remember it by, so players can say where things happened:

- Build a landmark from several objects: a ruin with rubble, a camp with tents and a fire, a wrecked cart.
- Give areas different ground and growth, so that one corner is rocky and another marshy.
- Vary the forms: a straight wall of trees is dull, a curving edge with gaps and clumps isn't.

## Gameplay comes first

Never make a map worse to play for the sake of its looks. What looks walkable and what is walkable are separate:
the map stores terrain, objects and pathing apart, so a gap that looks open can be blocked, and a slope that looks
fine can stop units. Trust check_path, not the picture, and check again after decorating. Block paths permanently with cliffs or water, not
with trees, since trees can be cut down. Doodads that block pathing change routes: use check_path after
decorating, and overlay pathing on terrain_screenshot to see what's blocked.

## Checks

- terrain_screenshot with view low at a few places: does the horizon look alive?
- terrain_screenshot with overlay heights: is the ground uneven everywhere it should be?
- Is any patch edge straight or smooth? Is any area just one tile?
- Does each area look different from the others?
- Does anything suggest a way that isn't one, or hide a way that is?
- Can you pick out roads, camps, shops and expansions from the picture alone?
