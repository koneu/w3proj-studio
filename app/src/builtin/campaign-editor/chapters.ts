// Chapter buttons of a new campaign. The game's campaign screen lists only the chapters whose
// button has flag 1 ("shown from the start"); the others appear when a map unlocks them. In the
// campaigns seen (CSW Tides of Darkness, The Invasion of Kalimdor Reworked, The Chosen Ones) the
// first chapter always has flag 1 and, in the one that stores clean values, the rest have 0. A
// campaign whose buttons all have flag 0 shows an empty chapter list.

export interface ChapterButton { flags: number; chapter: string; title: string; map: string }
export interface ChapterList { chapters: ChapterButton[]; mapOrder: { unknown: string; map: string }[] }

export const CHAPTER_SHOWN = 1;

/** The buttons (indices) that open `map`. */
export function buttonsOf(info: ChapterList, map: string): number[] {
  return info.chapters.flatMap((c, i) => (c.map.toLowerCase() === map.toLowerCase() ? [i] : []));
}

/** Takes `map` out of the map order (its file is removed from the campaign); buttons naming it stay, as in the
 *  World Editor (they show the map as missing). */
export function dropFromMapOrder(info: ChapterList, map: string) {
  info.mapOrder = info.mapOrder.filter((m) => m.map.toLowerCase() !== map.toLowerCase());
}

/** Adds `map` as the next chapter (button, and its place in the map order); returns its index. */
export function addChapter(info: ChapterList, map: string, title: string): number {
  const first = !info.chapters.some((c) => c.flags & CHAPTER_SHOWN);
  info.chapters.push({ flags: first ? CHAPTER_SHOWN : 0, chapter: `Chapter ${info.chapters.length + 1}`, title, map });
  if (!info.mapOrder.some((m) => m.map.toLowerCase() === map.toLowerCase())) info.mapOrder.push({ unknown: "", map });
  return info.chapters.length - 1;
}
