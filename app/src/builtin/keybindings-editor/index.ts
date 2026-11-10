// The Keyboard Shortcuts editor (VS Code's, for the World Editor's Configure Controls): every command, hidden ones too,
// with its keys in effect, where they apply (`when`) and where they come from (default or user). A key is changed by
// pressing it, taken away, or the command put back to its defaults; keys bound to more than one command are marked.
// What it changes goes into keybindings.json in the settings folder (w3.keybindings), which applies at once.

import type { ExtensionContext, KeybindingInfo, W3Api } from "../../extensions/api";
import { h } from "../../workbench/dom";
import { parseQuery, rowsOf, type Item, type Row } from "./rows";

/** The same key in effect (the editor's rows are made anew at each change). */
const sameBinding = (a: KeybindingInfo | null, b: KeybindingInfo | null) =>
  a === b || (!!a && !!b && a.key === b.key && a.command === b.command && (a.when ?? "") === (b.when ?? "") && a.source === b.source);

/** A first chord with Ctrl or Alt can start a key of two chords (Ctrl+K Ctrl+S); a plain key is a key of its own. */
const opensSequence = (chord: string) => /^(ctrl|alt)\+/.test(chord);

export function activate(w3: W3Api, ctx: ExtensionContext) {
  /** The open editor's search, for the command's argument ("@key:g"). */
  let setQuery: ((q: string) => void) | null = null;
  ctx.subscriptions.push(
    w3.commands.register("w3.keybindings.open", async (query?: unknown) => {
      await w3.editors.open("w3:keybindings");
      if (typeof query === "string") setQuery?.(query);
    }),
    w3.editors.registerProvider("w3.keybindingsEditor", {
      resolve(el) {
        const kb = w3.keybindings;
        const root = h("div.settings.kb");
        el.append(root);
        let recordingSearch = false;
        /** The row whose key is being recorded: its command and binding (null: a new key for the command). */
        let editing: { command: string; binding: KeybindingInfo | null; when?: string } | null = null;

        const search = h("input.settings-search.kb-search", {
          placeholder: "Type to search in commands and keys (@source:user, @key:ctrl+r)",
          oninput: () => renderList(),
          onkeydown: (e: KeyboardEvent) => {
            if (!recordingSearch) return;
            // Recording: the key pressed is the search.
            e.preventDefault();
            e.stopPropagation();
            const chord = kb.chordOf(e);
            if (chord) { search.value = `@key:${chord.replace(/ /g, "_")}`; renderList(); }
          },
        });
        const mySetQuery = (q: string) => { search.value = q; renderList(); };
        setQuery = mySetQuery;
        const recordButton = h("button.kb-record-search", {
          title: "Search by pressing the key itself",
          onclick: () => {
            recordingSearch = !recordingSearch;
            recordButton.classList.toggle("on", recordingSearch);
            if (recordingSearch) search.setAttribute("data-all-keys", ""); else search.removeAttribute("data-all-keys");
            search.focus();
          },
        }, "Record Keys");
        const fileLine = h("div.settings-tabs.kb-file");
        const list = h("div.kb-list");

        const showError = (e: unknown) => void w3.window.showError(String((e as Error)?.message ?? e));

        const renderFile = () => {
          const f = kb.file();
          fileLine.replaceChildren(
            h("span.settings-file.muted", {}, f.path ? `keybindings.json · ${f.path}` : "keybindings.json"),
            h("button.link-inline", { onclick: () => w3.commands.execute("workbench.openKeybindingsFile").catch(showError) }, "Open JSON"),
            ...(f.problem ? [h("div.kb-problem", {}, `keybindings.json is there, but ${f.problem}: its keys aren't used, and changes here are refused until it is fixed.`)] : []),
            ...(f.ignored.length ? [h("div.kb-problem", {}, `Left out of keybindings.json: ${f.ignored.join("; ")}.`)] : []),
          );
        };

        /** The field a new key is pressed into, in place of the row's key. */
        const recorder = (row: Row) => {
          const input = h("input.kb-record", { readOnly: true, placeholder: "Press the key, then Enter · Esc cancels", "data-all-keys": "" });
          const note = h("div.kb-conflicts.muted");
          let chords: string[] = [];
          let finished = false;
          const finish = async (key: string | null) => {
            if (finished) return;
            finished = true;
            const was = editing;
            editing = null;
            if (key && was) {
              try {
                if (was.binding) await kb.changeKey(was.binding, key);
                else await kb.addKey(was.command, key, was.when);
              } catch (e) { showError(e); }
            }
            renderList();
          };
          input.addEventListener("keydown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const chord = kb.chordOf(e);
            if (!chord) return;
            if (chord === "escape") { void finish(null); return; }
            if (chord === "enter" && chords.length) { void finish(chords.join(" ")); return; }
            chords = chords.length === 1 && opensSequence(chords[0]) ? [chords[0], chord] : [chord];
            const key = chords.join(" ");
            input.value = kb.label(key);
            const others = kb.conflicts({ key, command: row.item.command, when: editing?.when ?? row.binding?.when });
            note.textContent = others.length ? `Also bound to: ${others.map((o) => `${titleOf(o.command)}${o.when ? ` (when ${o.when})` : ""}`).join(", ")}` : "";
          });
          input.addEventListener("blur", () => void finish(null));
          queueMicrotask(() => input.focus());
          return h("div.kb-recorder", {}, input, note);
        };

        let titles = new Map<string, string>();
        const titleOf = (command: string) => titles.get(command) ?? command;

        const isEdited = (row: Row) => !!editing && editing.command === row.item.command && sameBinding(editing.binding, row.binding);
        const keyCell = (row: Row, all: KeybindingInfo[]) => {
          if (isEdited(row)) return recorder(row);
          if (!row.binding) return h("span.muted", {}, "—");
          const b = row.binding;
          const others = all.filter((o) => o.key === b.key && !(o.command === b.command && (o.when ?? "") === (b.when ?? "")));
          return h("span.kb-key-cell", {},
            h("kbd.kb-key", {}, kb.label(b.key)),
            others.length ? h("button.link-inline.kb-conflict", {
              title: `Also bound to: ${others.map((o) => `${titleOf(o.command)}${o.when ? ` (when ${o.when})` : ""}`).join(", ")}. Click to see them all.`,
              onclick: () => { search.value = `@key:${b.key.replace(/ /g, "_")}`; renderList(); },
            }, `${others.length + 1} commands`) : null);
        };

        const renderList = () => {
          const items = kb.items() as Item[];
          titles = new Map(items.map((i) => [i.command, i.category ? `${i.category}: ${i.title}` : i.title]));
          const all = items.flatMap((i) => i.bindings);
          const rows = rowsOf(items, parseQuery(search.value, kb.normalize), kb.label);
          // A new key for a command that has some already: its field goes after the command's last row (first, when the
          // search left the command out).
          if (editing && !editing.binding && !rows.some(isEdited)) {
            const item = items.find((i) => i.command === editing!.command);
            if (item) {
              let at = -1;
              rows.forEach((r, i) => { if (r.item.command === item.command) at = i; });
              rows.splice(at + 1, 0, { item, binding: null });
            }
          }
          const problem = !!kb.file().problem;
          const shown = rows.slice(0, 600);
          list.replaceChildren(
            h("div.kb-row.kb-head", {}, h("span", {}, "Command"), h("span", {}, "Keybinding"), h("span", {}, "When"), h("span", {}, "Source"), h("span", {})),
            ...(rows.length ? [] : [h("div.muted.kb-none", {}, "No commands match.")]),
            ...shown.map((row) => {
              const { item, binding } = row;
              const defaultsWhen = item.bindings.find((b) => b.source === "default")?.when;
              const change = () => { editing = { command: item.command, binding, ...(binding ? {} : defaultsWhen ? { when: defaultsWhen } : {}) }; renderList(); };
              return h(`div.kb-row${binding?.source === "user" ? ".user" : ""}`, { "data-command": item.command, "data-key": binding?.key ?? "", ondblclick: () => { if (!problem) change(); } },
                h("span.kb-command", { title: item.command }, h("span", {}, titleOf(item.command)), h("code.muted", {}, item.command)),
                keyCell(row, all),
                h("span.kb-when.muted", {}, binding?.when ?? ""),
                h("span.kb-source.muted", {}, binding ? (binding.source === "user" ? "User" : `Default${binding.extensionId && binding.extensionId !== "core" ? ` · ${binding.extensionId}` : ""}`) : ""),
                h("span.kb-actions", {},
                  h("button.link-inline.kb-change", { disabled: problem, title: binding ? "Press a new key for this" : "Bind a key to this command", onclick: change }, binding ? "Change" : "Add"),
                  binding ? h("button.link-inline.kb-add", { disabled: problem, title: "Another key for this command, besides this one", onclick: () => { editing = { command: item.command, binding: null, ...(binding.when ? { when: binding.when } : {}) }; renderList(); } }, "Add") : null,
                  binding ? h("button.link-inline.kb-when-edit", {
                    disabled: problem, title: "Where this key applies",
                    onclick: async () => {
                      const when = await w3.window.inputBox({ prompt: `When ${kb.label(binding.key)} runs ${titleOf(item.command)} (empty: everywhere; e.g. terrainFocus)`, value: binding.when ?? "" });
                      if (when !== undefined) await kb.changeWhen(binding, when).catch(showError);
                    },
                  }, "When") : null,
                  binding ? h("button.link-inline.kb-remove", { disabled: problem, title: "Take this key away", onclick: () => kb.remove(binding).catch(showError) }, "Remove") : null,
                  item.userTouched ? h("button.link-inline.kb-reset", { disabled: problem, title: "Back to this command's default keys", onclick: () => kb.reset(item.command).catch(showError) }, "Reset") : null));
            }),
            ...(rows.length > shown.length ? [h("div.muted.kb-none", {}, `${rows.length - shown.length} more: search to narrow it down.`)] : []),
          );
        };

        root.append(h("div.settings-top", {}, h("h1", {}, "Keyboard Shortcuts"), h("div.kb-search-line", {}, search, recordButton), fileLine), list);
        renderFile();
        renderList();
        const subs = [kb.onDidChange(() => { renderFile(); if (!editing) renderList(); })];
        return { focus: () => search.focus(), dispose: () => { subs.forEach((s) => s.dispose()); if (setQuery === mySetQuery) setQuery = null; } };
      },
    }),
  );
}
