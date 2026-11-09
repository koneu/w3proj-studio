// New Campaign: a campaign project with no chapters yet, as World Editor 3.0.1
// (editor 7003) makes one: only war3campaign.w3f (version 3), its texts (name,
// difficulty, author, description) stored as they are, no string table, no
// background, sound or fog (-1 and the editor's "unset" fog values). Chapter
// maps are added afterwards ("New map…" / "Add map…").

import type { W3Api } from "../../extensions/api";
import { joinPath } from "../../lib/paths";
import { h } from "../../workbench/dom";
import { keyOf } from "../../lib/keys";

export interface NewCampaignOptions { dir: string; name: string; author: string; difficulty: string; description: string; race: number }

const RACES: [number, string][] = [[0, "Human"], [1, "Orc"], [2, "Undead"], [3, "Night Elf"]];

/** The New Campaign dialog; resolves with the choices, or null when cancelled. */
export function askNewCampaign(w3: W3Api): Promise<NewCampaignOptions | null> {
  return new Promise((resolve) => {
    let parent = "";
    const name = h("input.newmap-input", { type: "text", value: CAMPAIGN_DEFAULTS.name, placeholder: "Campaign name" });
    const author = h("input.newmap-input", { type: "text", value: CAMPAIGN_DEFAULTS.author, placeholder: "Author" });
    const difficulty = h("input.newmap-input", { type: "text", value: CAMPAIGN_DEFAULTS.difficulty, placeholder: "Shown as the difficulty" });
    const description = h("textarea.newmap-input", { rows: 3, placeholder: "Description" });
    description.value = CAMPAIGN_DEFAULTS.description;
    const race = h("select", {}, ...RACES.map(([v, label]) => h("option", { value: String(v) }, label)));
    const folder = h("span.newmap-folder.muted", {}, "Choose a parent folder…");
    const error = h("div.newmap-error");
    const folderName = () => name.value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/[. ]+$/, "") || "Untitled Campaign";
    const target = () => (parent ? joinPath(parent, folderName()) : "");
    const update = () => {
      // Shown right-aligned to clip the start of long paths; the mark keeps them left-to-right.
      folder.textContent = parent ? `‎${target()}` : "Choose a parent folder…";
      folder.title = target();
      folder.classList.toggle("muted", !parent);
    };
    name.addEventListener("input", update);

    const close = (value: NewCampaignOptions | null) => { overlay.remove(); resolve(value); };
    const create = () => {
      if (!parent) { error.textContent = "Choose where to create the project."; return; }
      if (!name.value.trim()) { error.textContent = "The campaign needs a name."; return; }
      close({
        dir: target(), name: name.value.trim(), author: author.value.trim(), difficulty: difficulty.value.trim(),
        description: description.value.trim(), race: Number(race.value),
      });
    };
    const row = (label: string, ...content: (HTMLElement | string)[]) => h("label.newmap-row", {}, h("span.newmap-label", {}, label), ...content);
    const overlay = h("div.picker-overlay.newmap-overlay", {
      tabindex: -1,
      onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(null); },
      onkeydown: (e: KeyboardEvent) => {
        if (keyOf(e) === "Escape") close(null);
        if (keyOf(e) === "Enter" &&!(e.target instanceof HTMLTextAreaElement)) create();
      },
    }, h("div.picker.newmap-dialog", {},
      h("div.picker-header", {}, h("strong", {}, "New Campaign"), h("button.icon-button", { title: "Close (Esc)", onclick: () => close(null) }, "×")),
      row("Name", name),
      row("Author", author),
      row("Difficulty", difficulty),
      row("Description", description),
      row("Interface", race),
      row("Folder", h("button", { onclick: async (e: Event) => {
        e.preventDefault();
        const p = await w3.window.pickFolder({ title: "Create the campaign project in…" });
        if (p) { parent = p; update(); }
      } }, "Browse…"), folder),
      error,
      h("div.newmap-buttons", {},
        h("button", { onclick: () => close(null) }, "Cancel"),
        h("button.primary", { onclick: create }, "Create"))));
    document.body.append(overlay);
    name.focus();
    name.select();
  });
}

/** The texts of World Editor 3.0.1's new campaign (the same in every game language). */
export const CAMPAIGN_DEFAULTS = { name: "Just another Warcraft III campaign", difficulty: "Normal", author: "Unknown", description: "Nondescript" };

/** The fog values World Editor 3.0.1 writes for a new campaign: its "unset" sentinels (f32 0xFF080400 and 0xFF000000). */
export const FOG_UNSET_Z = -1.8079578e38, FOG_UNSET_DENSITY = -1.7014118e38;

/** war3campaign.w3f (as JSON) of a new campaign, as World Editor 3.0.1 (editor 7003) writes it: the texts as they are,
 *  no flags, background -1, ambient sound -1, fog style -1 with the unset fog values, and its unknown3. */
export function newCampaignInfo(o: Pick<NewCampaignOptions, "name" | "difficulty" | "author" | "description" | "race">) {
  return {
    format: "w3proj.campaign/1", version: 3, campaignVersion: 1, editorVersion: 7003,
    name: o.name, difficulty: o.difficulty, author: o.author, description: o.description,
    flags: 0, background: -1, backgroundPath: "", minimapPath: "", ambientSound: -1, ambientSoundPath: "",
    fogStyle: -1, fogStartZ: FOG_UNSET_Z, fogEndZ: FOG_UNSET_Z, fogDensity: FOG_UNSET_DENSITY, fogColor: [0, 0, 0, 0], race: o.race,
    unknown3: [0xff000000, 0xff000000, 0xff000000, 0xff000000, 0xff000000, 0, 0], chapters: [], mapOrder: [],
  };
}

/** Writes the campaign project for `o` and opens it (the workspace switches to it). */
export async function createCampaign(w3: W3Api, o: NewCampaignOptions): Promise<void> {
  await w3.backend.invoke("project_create", { dir: o.dir, name: o.name, flags: 0, maxPlayers: 0, campaign: true });
  await w3.workspace.open(o.dir);
  const root = w3.workspace.project()!.root;
  const path = "map/war3campaign.w3f.json";
  await w3.workspace.writeText(path, await w3.backend.invoke<string>("codec_canonicalize", { root, path, text: JSON.stringify(newCampaignInfo(o)) }));
  await w3.workspace.refresh();
}
