// Change Map Text Encoding: the open project's code page for texts that aren't UTF-8 (lib/formats/codepage.ts), in the
// status bar and the command palette, as VS Code shows and changes a file's encoding. The choice is the project setting
// map.textEncoding; each editor takes it when it opens, so a change opens the open editors again (those with unsaved
// changes keep showing the choice they were opened with until they are saved and opened again).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { canRead, CODE_PAGES, codePageOf, encodingLabel, TEXT_ENCODING_SETTING, type CodePage } from "../../lib/formats/codepage";

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const item = w3.statusBar.add({ id: "w3.textEncoding.status", text: "", command: "w3.textEncoding.change", align: "right", priority: 9 });
  ctx.subscriptions.push(item);
  const current = () => codePageOf(w3.settings.get(TEXT_ENCODING_SETTING));
  const update = () => {
    const open = !!w3.workspace.project();
    const cp = current();
    item.text = open ? `Texts: ${encodingLabel(cp)}` : "";
    item.tooltip = open
      ? `${cp ? `The map's texts that aren't UTF-8 show as ${CODE_PAGES[cp].description}; edited texts are written in it.` : "The map's texts as they are (UTF-8): an old map's code page shows as boxes."} Click to change.`
      : "";
  };
  update();
  ctx.subscriptions.push(w3.workspace.onDidChange(update));
  ctx.subscriptions.push(w3.settings.onDidChange((key) => { if (key === TEXT_ENCODING_SETTING) update(); }));

  ctx.subscriptions.push(w3.commands.register("w3.textEncoding.change", async (value?: unknown) => {
    const project = w3.workspace.project();
    if (!project) throw new Error("Open a project first.");
    const now = current();
    let next: CodePage | null;
    if (value !== undefined) {
      // From a script or another extension: "utf-8" or a code page.
      next = codePageOf(value);
      if (next === null && value !== "utf-8") throw new Error(`${String(value)} isn't a map text encoding: utf-8, ${Object.keys(CODE_PAGES).join(", ")}.`);
    } else {
      const items = [
        { label: "UTF-8", description: "texts as they are (an old map's code page shows as boxes)", value: null as CodePage | null },
        ...(Object.keys(CODE_PAGES) as CodePage[]).map((cp) => ({ label: CODE_PAGES[cp].label, description: CODE_PAGES[cp].description, value: cp as CodePage | null,
          disabled: canRead(cp) ? undefined : "This system can't read it" })),
      ].map((i) => (i.value === now ? { ...i, detail: "current" } : i));
      const picked = await w3.window.quickPick(items, { placeholder: "The code page of the map's texts that aren't UTF-8" });
      if (!picked) return now ?? "utf-8";
      next = picked.value ?? null;
    }
    if (next !== null && !canRead(next)) throw new Error(`This system can't read ${CODE_PAGES[next].label}.`);
    // The project may have changed while the list was open.
    if (w3.workspace.project()?.root !== project.root) throw new Error("Not changed: another project was opened meanwhile.");
    if (next === now) return next ?? "utf-8";
    await w3.settings.set(TEXT_ENCODING_SETTING, next ?? undefined, "project");
    // The editors take the choice when they open: those without unsaved changes open again with it.
    const kept: string[] = [];
    for (const path of w3.editors.openPaths()) {
      if (w3.editors.isDirty(path)) { kept.push(path); continue; }
      await w3.editors.reopen(path).catch(() => 0);
    }
    if (kept.length) {
      void w3.window.showInfo(`${kept.length === 1 ? `${kept[0]} has` : `${kept.length} editors have`} unsaved changes and keep${kept.length === 1 ? "s" : ""} `
        + `showing texts as ${encodingLabel(now)} until saved and opened again.`);
    }
    return next ?? "utf-8";
  }));
}
