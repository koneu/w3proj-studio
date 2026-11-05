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

/** Whether a user's file says anything, past the comment it starts with. */
export const hasRules = (own: string) => stripComments(own).length > 0;

/** A guide with the user's rules after it. */
export function withOwnRules(guide: string, own: string) {
  if (!hasRules(own)) return guide;
  return `${guide}\n## The user's own rules\n\nThese come from the user. Where they disagree with anything above, they win.\n\n${stripComments(own)}\n`;
}

/** What a user's file starts with. */
export const rulesTemplate = (topic: string) => `<!--
Your own rules for the ${topic} guide, in plain words: write below this comment.
They're added to the guide, and win where the two disagree. The guide itself stays up to date.
The AI doesn't see this comment.
-->

`;
