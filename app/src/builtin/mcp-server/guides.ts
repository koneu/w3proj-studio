// Guides an AI reads before a job that needs more than the tools' descriptions. They live in guides/,
// in our own words, each with its sources in a comment at the top. A user adds rules of their own in
// the app's config folder: those are attached to the guide, and win.

import melee from "./guides/melee.md?raw";
import spells from "./guides/spells.md?raw";
import terrain from "./guides/terrain.md?raw";

export interface Guide { summary: string; text: string }

const stripComments = (text: string) => text.replace(/<!--[\s\S]*?-->/g, "").trim();

/** A guide as stored: `summary:` in a comment, which like all comments the AI never sees. */
export function parseGuide(raw: string): Guide {
  return { summary: /^summary:\s*(.+)$/m.exec(raw)?.[1].trim() ?? "", text: `${stripComments(raw)}\n` };
}

export const GUIDES: Record<string, Guide> = { terrain: parseGuide(terrain), spells: parseGuide(spells), melee: parseGuide(melee) };

/** Starting points for a melee map. Left alone, an AI builds the same map every time, and each chat
 *  starts fresh, so a guide can't ask it to vary: read_guide picks one by chance. */
export const LAYOUT_IDEAS = [
  "Open field: hardly any terrain in the way. Camps, distances and scattered forest clumps make the game, as on Northern Isles.",
  "Ring: something big fills the middle, a lake, a mesa or a deep forest, so armies go round left or right, and a player has to guess which.",
  "Raised middle: bases on ordinary ground, a broad plateau in the centre with wide ramps, holding the tavern. Whoever holds it sees the map.",
  "One long road: a single winding main way between the bases, as on Terenas Stand, with camps and expansions off to its sides. Long walks, so harassing costs time.",
  "Water map: wide water divides the map, and shallow fords are the crossings. Few places to cross, so each one matters.",
  "Forest map: tree walls do the work instead of cliffs, leaving clearings joined by broad gaps. Lumber opens new ways as the game goes on.",
  "River: one river runs corner to corner between the bases, with two or three fords and land bridges at different points along it.",
  "Terraces: the ground steps up across the map in long low cliffs with wide ramps, so every fight has a high side and a low side.",
];

/** One of them, as a section for the end of the melee guide. */
export const layoutIdea = (random: () => number) => `
## The idea for this map

Unless the user asked for something else, start from this one, picked by chance so that maps differ:

${LAYOUT_IDEAS[Math.floor(random() * LAYOUT_IDEAS.length) % LAYOUT_IDEAS.length]}

Make it your own, and keep it clear: a map should be describable in one sentence.
`;

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
