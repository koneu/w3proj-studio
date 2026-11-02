// The Settings editor: every declared setting (workbench and extension
// manifests' `contributes.configuration`), grouped by section, editable in
// the user layer or the open project's layer (.w3proj/settings.json).

import type { ExtensionContext, SettingInfo, SettingsTarget, W3Api } from "../../extensions/api";
import { h } from "../../workbench/dom";

/** "terrain.minimap.waterAlpha" → "Minimap: Water Alpha" (section prefix dropped). */
function label(key: string): string {
  const parts = key.split(".");
  const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  const name = words(parts[parts.length - 1]);
  return parts.length > 2 ? `${words(parts[parts.length - 2])}: ${name}` : name;
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(
    w3.commands.register("w3.settings.open", () => w3.editors.open("w3:settings")),
    w3.editors.registerProvider("w3.settingsEditor", {
      resolve(el) {
        let target: SettingsTarget = "user";
        let filter = "";
        const root = h("div.settings");
        el.append(root);
        const search = h("input.settings-search", {
          placeholder: "Search settings",
          oninput: () => { filter = search.value.trim().toLowerCase(); renderList(); },
        });
        const tabs = h("div.settings-tabs");
        const list = h("div.settings-list");

        const renderTabs = () => {
          const project = w3.workspace.project();
          const tab = (t: SettingsTarget, text: string, disabled = false) =>
            h(`button.settings-tab${t === target ? ".on" : ""}`, { disabled, title: disabled ? "Open a project to edit its settings" : undefined, onclick: () => { target = t; render(); } }, text);
          tabs.replaceChildren(
            tab("user", "User"),
            tab("project", project ? `Project (${project.name})` : "Project", !project),
            h("span.settings-file.muted", {}, target === "user" ? "settings.json" : ".w3proj/settings.json · versioned with the project"),
            h("button.link-inline", { onclick: () => w3.commands.execute(target === "user" ? "workbench.openSettings" : "workbench.openProjectSettings").catch((e) => w3.window.showError(String(e))) }, "Open JSON"),
          );
        };

        const control = (s: SettingInfo, value: unknown, editable: boolean) => {
          const p = s.property;
          const commit = (v: unknown) => w3.settings.set(s.key, v, target).catch((e) => w3.window.showError(String((e as Error).message ?? e)));
          if (p.type === "boolean") return h("input", { type: "checkbox", checked: !!value, disabled: !editable, onchange: (e: Event) => commit((e.target as HTMLInputElement).checked) });
          if (p.enum) {
            const sel = h("select", { disabled: !editable, onchange: () => commit(p.enum![Number(sel.value)]) },
              ...p.enum.map((v, i) => h("option", { value: String(i), selected: v === value }, p.enumDescriptions?.[i] ? `${p.enumDescriptions[i]} (${String(v)})` : String(v))));
            return sel;
          }
          if (p.type === "number" || p.type === "integer") {
            return h("input.settings-num", {
              type: "number", value: String(value ?? ""), disabled: !editable,
              step: p.type === "integer" ? "1" : "any", min: p.minimum !== undefined ? String(p.minimum) : undefined, max: p.maximum !== undefined ? String(p.maximum) : undefined,
              onchange: (e: Event) => {
                const input = e.target as HTMLInputElement;
                let v = Number(input.value);
                if (input.value.trim() === "" || !Number.isFinite(v)) { input.classList.add("invalid"); return; }
                if (p.type === "integer") v = Math.round(v);
                if (p.minimum !== undefined) v = Math.max(p.minimum, v);
                if (p.maximum !== undefined) v = Math.min(p.maximum, v);
                input.classList.remove("invalid");
                void commit(v);
              },
            });
          }
          if (p.type === "array" || p.type === "object") {
            const area = h("textarea.settings-json", {
              rows: 2, disabled: !editable,
              onchange: () => {
                try {
                  const v = JSON.parse(area.value);
                  if (p.type === "array" ? !Array.isArray(v) : typeof v !== "object" || Array.isArray(v) || v === null) throw new Error();
                  area.classList.remove("invalid");
                  void commit(v);
                } catch { area.classList.add("invalid"); }
              },
            });
            // A textarea's content is its value property, not an attribute.
            area.value = JSON.stringify(value ?? (p.type === "array" ? [] : {}));
            return area;
          }
          return h("input.settings-text", { type: "text", value: String(value ?? ""), disabled: !editable, onchange: (e: Event) => commit((e.target as HTMLInputElement).value) });
        };

        const renderList = () => {
          const all = w3.settings.declared().filter((s) => !filter || `${s.key} ${s.section} ${label(s.key)} ${s.property.description ?? ""}`.toLowerCase().includes(filter));
          const sections = new Map<string, SettingInfo[]>();
          for (const s of all) sections.set(s.section, [...(sections.get(s.section) ?? []), s]);
          list.replaceChildren(...(all.length ? [] : [h("div.muted", {}, "No settings match.")]),
            ...[...sections].map(([section, items]) => h("section.settings-section", {},
              h("h2", {}, section),
              ...items.map((s) => {
                const info = w3.settings.inspect(s.key);
                const userOnly = s.property.scope === "user";
                const editable = target === "user" || !userOnly;
                const own = target === "user" ? info.user : info.project;
                const value = own !== undefined ? own : w3.settings.get(s.key);
                const marks = [
                  info.user !== undefined ? h("span.settings-mark", { title: "Set in user settings" }, "user") : null,
                  info.project !== undefined && !userOnly ? h("span.settings-mark.project", { title: "Set for this project (overrides user)" }, "project") : null,
                ];
                return h(`div.settings-row${own !== undefined ? ".modified" : ""}`, {},
                  h("div.settings-head", {},
                    h("span.settings-label", {}, label(s.key)), h("code.muted", {}, s.key), ...marks,
                    own !== undefined ? h("button.link-inline", { title: `Remove from ${target} settings`, onclick: () => w3.settings.set(s.key, undefined, target) }, "Reset") : null),
                  s.property.description ? h("div.settings-desc.muted", {}, s.property.description) : null,
                  h("div.settings-control", {}, control(s, value, editable),
                    !editable ? h("span.muted", {}, "User setting — not per project") : own === undefined ? h("span.muted", {}, info.user !== undefined && target === "project" ? "inherited from user" : "default") : null),
                );
              }))));
        };

        const render = () => { renderTabs(); renderList(); };
        root.append(h("div.settings-top", {}, h("h1", {}, "Settings"), search, tabs), list);
        render();
        const subs = [w3.settings.onDidChange(() => renderList()), w3.workspace.onDidChange(() => { if (target === "project" && !w3.workspace.project()) target = "user"; render(); })];
        return { focus: () => search.focus(), dispose: () => subs.forEach((s) => s.dispose()) };
      },
    }),
  );
}
