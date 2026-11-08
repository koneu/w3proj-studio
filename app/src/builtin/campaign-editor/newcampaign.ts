// New Campaign: a campaign project with no chapters yet. Its texts (name,
// difficulty, author, description) go into war3campaign.wts as the World
// Editor stores them; war3campaign.w3f is written in the newest layout seen
// (version 3, editor build 7003). Chapter maps are added afterwards
// ("New map…" / "Add map…").

import type { W3Api } from "../../extensions/api";
import { joinPath } from "../../lib/paths";
import { WtsCutError, wtsCuts } from "../../lib/formats/wts";
import { h } from "../../workbench/dom";

export interface NewCampaignOptions { dir: string; name: string; author: string; difficulty: string; description: string; race: number }

const RACES: [number, string][] = [[0, "Human"], [1, "Orc"], [2, "Undead"], [3, "Night Elf"]];

/** The New Campaign dialog; resolves with the choices, or null when cancelled. */
export function askNewCampaign(w3: W3Api): Promise<NewCampaignOptions | null> {
  return new Promise((resolve) => {
    let parent = "";
    const name = h("input.newmap-input", { type: "text", value: "Untitled Campaign", placeholder: "Campaign name" });
    const author = h("input.newmap-input", { type: "text", value: "", placeholder: "Author" });
    const difficulty = h("input.newmap-input", { type: "text", value: "Normal", placeholder: "Shown as the difficulty" });
    const description = h("textarea.newmap-input", { rows: 3, placeholder: "Description" });
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
      // The texts go into war3campaign.wts, where a line starting with `}` would cut them.
      const cuts = wtsCuts([name, difficulty, author, description].map((e, i) => [i + 1, e.value.trim()] as [number, string]));
      if (cuts.length) {
        const label = ["Name", "Difficulty", "Author", "Description"];
        error.textContent = `${cuts.map((c) => `${label[c.num - 1]} (line ${c.lines.join(", ")})`).join(", ")}: a line that starts with "}" ends the text in the game, and the rest is dropped. Start it with a space (" }") or remove it.`;
        return;
      }
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
        if (e.key === "Escape") close(null);
        if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) create();
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

/** war3campaign.wts with the given strings (numbered from 1), with a BOM like the World Editor writes. */
function stringTable(values: string[]): string {
  return String.fromCharCode(0xfeff) + values.map((v, i) => `STRING ${i + 1}\r\n{\r\n${v.replace(/\r?\n/g, "\r\n")}\r\n}\r\n\r\n`).join("");
}

/** Writes the campaign project for `o` and opens it (the workspace switches to it). */
export async function createCampaign(w3: W3Api, o: NewCampaignOptions): Promise<void> {
  // Before anything is created: a text with a `}` line would be cut in war3campaign.wts.
  const cuts = wtsCuts([o.name, o.difficulty, o.author, o.description].map((v, i) => [i + 1, v] as [number, string]));
  if (cuts.length) throw new WtsCutError(cuts, "Not created: ");
  await w3.backend.invoke("project_create", { dir: o.dir, name: o.name, flags: 0, maxPlayers: 0, campaign: true });
  await w3.workspace.open(o.dir);
  const root = w3.workspace.project()!.root;
  const info = {
    format: "w3proj.campaign/1", version: 3, campaignVersion: 1, editorVersion: 6116,
    name: "TRIGSTR_001", difficulty: "TRIGSTR_002", author: "TRIGSTR_003", description: "TRIGSTR_004",
    // Variable difficulty (flag 1) as the game's campaigns; the first background and no ambient sound.
    flags: 1, background: 0, backgroundPath: "", minimapPath: "", ambientSound: 0, ambientSoundPath: "",
    fogStyle: 0, fogStartZ: 0, fogEndZ: 0, fogDensity: 0, fogColor: [0, 0, 0, 0], race: o.race,
    unknown3: [0, 0, 0, 0, 0, 0, 1], chapters: [], mapOrder: [],
  };
  const path = "map/war3campaign.w3f.json";
  await w3.workspace.writeText(path, await w3.backend.invoke<string>("codec_canonicalize", { root, path, text: JSON.stringify(info) }));
  await w3.workspace.writeText("map/war3campaign.wts", stringTable([o.name, o.difficulty, o.author, o.description]));
  await w3.workspace.refresh();
}
