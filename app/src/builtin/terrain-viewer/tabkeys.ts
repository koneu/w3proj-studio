// The World Editor's palette keys in the terrain view, as commands bringing Studio's tabs to the front. Their keys are
// the terrain view's default key bindings (extension.json `contributes.keybindings`, which the user can change).
//
// Measured with we-drive (branch terrain-hotkeys, 2026-11-20, SD; docs/testing/branch-rounds.md): the editor's Layer
// menu is Terrain T, Doodads D, Units U, Regions R, Cameras M, and those five letters are its only single keys that
// switch the tool palette (every other letter and digit leaves it; Shift, Ctrl and Alt with them don't switch). Space
// goes from a brush to the palette's selection brush and back to the brush again; Escape ends a brush (the selection
// brush, the palette stays). Studio's Select tab is the selection brush, its Objects tab holds doodads and units, so:
// T the Terrain tab, D, U and O (Studio's own) the Objects tab, R Regions, M Cameras; Space goes to the Select tab and,
// from there, back to the tab before; Escape with nothing else to end and nothing selected goes to the Select tab.

/** Each tab key's command and the tab (tool group id) it brings to the front. */
export const TAB_COMMANDS: Readonly<Record<string, string>> = {
  "w3.terrain.tab.terrain": "terrain",
  "w3.terrain.tab.objects": "objects",
  "w3.terrain.tab.doodads": "objects",
  "w3.terrain.tab.units": "objects",
  "w3.terrain.tab.regions": "regions",
  "w3.terrain.tab.cameras": "cameras",
};

/** Space: the Select tab, or from there the tab that was open before it. */
export const SELECT_TOGGLE_COMMAND = "w3.terrain.tab.toggleSelect";

/** The tab key commands, for the view's own key commands (selectionkeys.ts KEY_COMMANDS). */
export const TAB_KEY_COMMANDS: readonly string[] = [...Object.keys(TAB_COMMANDS), SELECT_TOGGLE_COMMAND];

/** Whether one of `commands` is a tab key's. */
export const hasTabKey = (commands: readonly string[]) => commands.some((c) => TAB_KEY_COMMANDS.includes(c));

/** Where the first tab key among `commands` (what a key is bound to, the winner first) goes: a tab's id, null for the
 *  Select tab, undefined when none of them is a tab key or it has nowhere to go (Space on the Select tab with no tab
 *  open before, a tab this editor hasn't). `active` is the open tab (null: Select), `last` the tab open before the
 *  Select tab, `has` whether this editor has a tab (an extension may be off). */
export function tabTarget(commands: readonly string[], active: string | null, last: string | null, has: (id: string) => boolean): string | null | undefined {
  for (const c of commands) {
    if (c === SELECT_TOGGLE_COMMAND) {
      if (active !== null) return null;
      return last !== null && has(last) ? last : undefined;
    }
    const tab = TAB_COMMANDS[c];
    if (tab !== undefined) return has(tab) ? tab : undefined;
  }
  return undefined;
}

/** What Escape does once nothing before it took it (picking a point, the paste, the area drawn, the open tab's own
 *  placing or selected region or camera): ends facing the pointer, else clears the selected objects, else goes from a
 *  tab to the Select tab; on the Select tab with nothing selected, nothing. */
export function lateCancel(s: { facing: boolean; selected: number; tab: string | null }): "facing" | "selection" | "selectTab" | "none" {
  if (s.facing) return "facing";
  if (s.selected > 0) return "selection";
  if (s.tab !== null) return "selectTab";
  return "none";
}
