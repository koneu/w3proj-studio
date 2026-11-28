// Guides an AI reads before a job that needs more than the tools' descriptions. They live in guides/,
// in our own words, each with its sources in a comment at the top. A user adds rules of their own in
// the app's config folder: those are attached to the guide, and win.

import melee from "./guides/melee.md?raw";
import spells from "./guides/spells.md?raw";
import terrain from "./guides/terrain.md?raw";

export interface Guide { summary: string; text: string }

const stripComments = (text: string) => {
  // Looked for again after every cut, so one cut out can't leave the start of another behind; a comment never closed
  // is cut to the end.
  let out = text;
  for (let at = out.indexOf("<!--"); at >= 0; at = out.indexOf("<!--")) {
    const end = out.indexOf("-->", at + 4);
    out = out.slice(0, at) + (end < 0 ? "" : out.slice(end + 3));
  }
  return out.trim();
};

/** A guide as stored: `summary:` in a comment, which like all comments the AI never sees. */
export function parseGuide(raw: string): Guide {
  return { summary: /^summary:\s*(.+)$/m.exec(raw)?.[1].trim() ?? "", text: `${stripComments(raw)}\n` };
}

export const GUIDES: Record<string, Guide> = { terrain: parseGuide(terrain), spells: parseGuide(spells), melee: parseGuide(melee) };

/** Starting points for a melee map. Left alone, an AI builds the same map every time, and each chat
 *  starts fresh, so a guide can't ask it to vary: read_guide picks one by chance. */
export const LAYOUT_IDEAS = [
  "Open middle: one broad field in the centre where armies meet, as on Northern Isles, the most open of the ladder maps (a quarter of its walkable ground lies in the open; no ladder map has more). Everything round it is closed in by forest and water: bases, camps and expansions still sit in pockets, and the forest is walls with ways through, not clumps standing in a field.",
  "Ring: something big fills the middle, a lake, a mesa or a deep forest, so armies go round left or right, and a player has to guess which.",
  "Raised middle: bases on ordinary ground, a broad plateau in the centre with wide ramps, holding the tavern. Whoever holds it sees the map.",
  "One long road: a single winding main way between the bases, as on Terenas Stand, with camps and expansions off to its sides. Long walks, so harassing costs time.",
  "Water map: wide water divides the map, and shallow fords are the crossings. Few places to cross, so each one matters.",
  "Forest map: tree walls do the work instead of cliffs, leaving clearings joined by broad gaps. Lumber opens new ways as the game goes on.",
  "River: one river runs corner to corner between the bases, with two or three fords and land bridges at different points along it.",
  "Terraces: the ground steps up across the map in long low cliffs with wide ramps, so every fight has a high side and a low side.",
];

/** Each idea as a graph to realise, for one half of the map (the other is its twin): the places as nodes, the ways
 *  between them as edges with how wide they are and about how long the walk is. A sentence leaves the layout to
 *  habit; a graph says what joins what. Walks and widths lie inside what the game's two-player maps have (the walk to
 *  the natural 4,500 to 7,100, base to base 9,300 to 14,500, ways to camps about 480). Same order as LAYOUT_IDEAS. */
export const LAYOUT_GRAPHS = [
  "base -(640 wide, 3,000)- field edge; base -(480, 5,000)- natural [mine, guard level 9-11, same level as the base]; field edge -(the field itself, 1,200 across)- middle [tavern]; field edge -(480)- camp A [level 8-10], camp B [level 12-14], each in its own pocket off the field; natural -(480, 2,500)- shop pocket [guard level 10-12]; far corner [second expansion, guard level 16-20] -(480, 3,500)- field edge.",
  "base -(640, 2,500)- fork; fork -(640, 4,500)- north pass; fork -(640, 4,500)- south pass; the passes meet the enemy's fork: the middle between them is closed (lake, mesa or forest), about 2,500 across; base -(480, 5,000)- natural [mine, guard level 9-11] beside the north way; south pass -(400)- camp A [level 12-14]; north pass -(400)- camp B [level 8-10]; a shop [guard level 10-12] in a pocket on the middle's shore, reached from the south pass; second expansion [guard level 16-20] at the far end of the north pass.",
  "base -(640, 3,500)- ramp foot; ramp foot -(ramp, width 4)- plateau [tavern in its middle, 2,000 across, one level up]; a second ramp on the plateau's far side leads to the enemy's ramp foot; base -(480, 5,000)- natural [mine, guard level 9-11, on the base's level]; ramp foot -(480)- camp A [level 8-10] in a pocket under the plateau's wall; plateau -(400)- camp B [level 14-16] in a corner of the plateau; low ground round the plateau -(480, 6,000)- second expansion [guard level 16-20]; shop [guard level 10-12] off the low way.",
  "base -(640, 2,000)- road start; the road (640 wide, 11,000 to 13,000 from base to base) winds in two or three long bends; off the road, each by a side way 480 wide and 800 to 1,500 long: natural [mine, guard level 9-11] at 5,000 from the base, camp A [level 8-10] at 3,500, shop [guard level 10-12] near the middle bend, camp B [level 12-14], second expansion [guard level 16-20] at the bend furthest from both bases. Nothing but the road joins the halves.",
  "base -(640, 3,000)- shore; shore -(ford of shallow water, 500 wide)- middle island [tavern]; a second ford 3,000 further along the shore joins the enemy's side directly; base -(480, 5,000)- natural [mine, guard level 9-11] on the base's side of the water; camp A [level 8-10] in a pocket by the first ford; camp B [level 12-14] on the island; shop [guard level 10-12] on a spit reached from the second ford; second expansion [guard level 16-20] on an island of its own with one ford.",
  "base clearing -(gap 500 wide)- clearing 1, the natural [mine, guard level 9-11], 5,000 from the base; clearing 1 -(gap 500)- clearing 2 [shop, guard level 10-12]; clearing 2 -(gap 640)- middle clearing [tavern]; base clearing -(gap 640, 3,500)- middle clearing by another way; camp A [level 8-10] and camp B [level 12-14], each in a clearing of its own with one gap 400 wide, off clearings 1 and 2; second expansion [guard level 16-20] behind a tree wall three trees thick: only lumbering opens it early, a gap 400 wide leads there the long way.",
  "base -(640, 3,000)- near bank; the river runs from corner to corner between the bases, 600 to 900 wide, deep; near bank -(ford A, 500 wide)- far bank, on the short way (base to base 10,000); near bank -(land bridge, 400 wide)- far bank 4,000 upstream; ford B 4,000 downstream; base -(480, 5,000)- natural [mine, guard level 9-11] on the near bank upstream; camp A [level 8-10] in a pocket by the land bridge; camp B [level 12-14] by ford B; shop [guard level 10-12] on the near bank downstream; second expansion [guard level 16-20] at the river's far end.",
  "base terrace [level 2] -(ramp, width 4)- middle terrace [level 3, 2,500 deep, runs the map's width]; middle terrace -(ramp, width 4)- enemy's base terrace; a second pair of ramps 5,000 along the terraces; base -(480, 5,000)- natural [mine, guard level 9-11] on the base terrace; camp A [level 8-10] in a pocket under the cliff of the middle terrace; camp B [level 12-14] on the middle terrace by the second ramp; tavern in the middle of the middle terrace; shop [guard level 10-12] on a ledge of its own [level 4] with one ramp; second expansion [guard level 16-20] at the far end of the base terrace.",
];

/** One of them, as a section for the end of the melee guide. */
export const layoutIdea = (random: () => number) => {
  const at = Math.floor(random() * LAYOUT_IDEAS.length) % LAYOUT_IDEAS.length;
  return `
## The idea for this map

Unless the user asked for something else, start from this one, picked by chance so that maps differ:

${LAYOUT_IDEAS[at]}

As a graph for one half of the map (the other half is its twin, turned 180° round the middle). Places are nodes,
"-(width, walk)-" is a way between two of them, [..] what stands at a place:

${LAYOUT_GRAPHS[at]}

Realise the graph: reserve its places and ways first (reserve_area), build the walls between them (set_cliff_level,
set_water, fill_forest), then place what stands there. The numbers are a start, inside what the game's two-player
maps have; check_melee's comparison says where the result ends up. Make it your own, and keep it clear: a map
should be describable in one sentence.
`;
};

/** Whether a user's file says anything, past the comment it starts with. */
export const hasRules = (own: string) => stripComments(own).length > 0;

/** A guide with the user's rules after it. */
export function withOwnRules(guide: string, own: string) {
  if (!hasRules(own)) return guide;
  return `${guide}\n## The user's own rules\n\nThese come from the user. Where they disagree with anything above, they win.\n\n${stripComments(own)}\n`;
}

/** The topics of a user's folder that aren't built in: its .md files directly inside it, by name. A
 *  file named like a built-in guide holds rules for that one. */
export function ownTopics(paths: readonly string[], folder: string) {
  const inside = folder.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() + "/";
  const builtIn = new Set(Object.keys(GUIDES).map((t) => t.toLowerCase()));
  const topics = paths.map((p) => p.replace(/\\/g, "/")).map((p) => (p.toLowerCase().startsWith(inside) ? p.slice(inside.length) : p))
    .filter((p) => !p.includes("/") && /\.md$/i.test(p)).map((p) => p.slice(0, -3))
    .filter((t) => isTopic(t) && !builtIn.has(t.toLowerCase()));
  return [...new Set(topics)].sort((a, b) => a.localeCompare(b));
}

/** A name that can be a file, a topic and a word in the panel. */
export const isTopic = (name: string) => /^[\p{L}\p{N}_ -]{1,60}$/u.test(name) && name.trim() === name;

/** A user's own guide, which may be as plain as a few lines: without a `summary:` comment its first
 *  line says what it's about. */
export function parseOwnGuide(raw: string): Guide {
  const guide = parseGuide(raw);
  const first = guide.text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").trim() ?? "";
  return { summary: guide.summary || first, text: guide.text };
}

/** What a new guide of a user's starts with. */
export const guideTemplate = (topic: string) => `<!--
summary: One line on when the AI should read this guide.

The AI doesn't see this comment, but it does see the summary when it lists the guides.
-->

# ${topic}

`;

/** What a user's file starts with. */
export const rulesTemplate = (topic: string) => `<!--
Your own rules for the ${topic} guide, in plain words: write below this comment.
They're added to the guide, and win where the two disagree. The guide itself stays up to date.
The AI doesn't see this comment.
-->

`;
