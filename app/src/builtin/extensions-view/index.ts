import type { ExtensionContext, W3Api } from "../../extensions/api";
import { blockedBy, neededBy, requires } from "../../extensions/graph";
import { joinPath } from "../../lib/paths";
import { h } from "../../workbench/dom";

const SAMPLE_MANIFEST = {
  id: "sample.hello",
  name: "Hello Sample",
  version: "0.1.0",
  description: "Example user extension: a command and a sidebar view.",
  main: "main.js",
  contributes: {
    commands: [{ id: "sample.hello.countLines", title: "Count Script Lines", category: "Sample" }],
    viewContainers: [{ id: "sample", title: "Sample", icon: "☺", order: 50 }],
    views: [{ id: "sample.hello.view", title: "Script Stats", container: "sample" }],
  },
};

const SAMPLE_MAIN = `// User extensions are plain ES modules. They get the same API as built-ins.
export function activate(w3, ctx) {
  const countLines = async () => {
    const file = w3.workspace.files().find((f) => /(^|\\/)war3map\\.(j|lua)$/i.test(f.path));
    if (!file) return null;
    const text = await w3.workspace.readText(file.path);
    return { path: file.path, lines: text.split("\\n").length };
  };

  ctx.subscriptions.push(
    w3.commands.register("sample.hello.countLines", async () => {
      const r = await countLines();
      w3.window.showInfo(r ? r.path + " has " + r.lines + " lines" : "No map script in this project.");
    }),
    w3.views.register("sample.hello.view", {
      render(el) {
        el.textContent = "Counting…";
        countLines().then((r) => { el.textContent = r ? r.path + ": " + r.lines + " lines" : "No project open."; });
      },
    }),
    w3.workspace.onDidChange(() => w3.views.refresh("sample.hello.view")),
  );
}
`;

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const paths = () => w3.backend.invoke<{ user_extensions: string }>("app_paths");

  interface FormatInfo { name: string; description: string; files: string[]; source: string; builtin: boolean }

  /** Format definitions: the data-driven layouts of Blizzard files. Listed
   *  here because they are the "system" layer users can override. */
  const renderFormats = () => {
    const section = h("div.ext-formats", {}, h("div.ext-section-title", {}, "FORMATS"), h("div.view-empty", {}, "Loading…"));
    const root = w3.workspace.project()?.root ?? null;
    w3.backend.invoke<FormatInfo[]>("formats_list", { root }).then((formats) => {
      section.replaceChildren(
        h("div.ext-section-title", {}, "FORMATS"),
        h("div.ext-desc.ext-formats-hint", {}, "How Blizzard files are read and written. A project can override a definition in .w3proj/formats; re-sync from the .w3x afterwards."),
        ...formats.map((f) => {
          const origin = f.builtin ? "builtin" : f.source.toLowerCase().includes("\\.w3proj\\") || f.source.toLowerCase().includes("/.w3proj/") ? "project" : "user";
          return h("div.ext-item", {},
            h("div.ext-title", {},
              h("strong", {}, f.name),
              h(`span.badge.${origin}`, {}, origin),
            ),
            h("div.ext-id", {}, f.files.join(", ")),
            f.description ? h("div.ext-desc", {}, f.description) : null,
            h("div.ext-actions", {},
              f.builtin
                ? h("button", {
                    title: root ? "Copy this definition into the project to edit it" : "Open a project first",
                    disabled: !root,
                    onclick: async () => {
                      const path = await w3.backend.invoke<string>("format_customize", { root, name: f.name });
                      await w3.workspace.refresh();
                      w3.views.refresh("w3.extensions.installed");
                      await w3.editors.open(path, "w3.textEditor");
                      w3.window.showInfo(`${f.name} is now a project definition (${path}). Edit it, then re-sync the project from the .w3x.`);
                    },
                  }, "Customize")
                : h("button", { onclick: () => w3.editors.open(f.source, "w3.textEditor") }, "Open"),
            ),
          );
        }),
      );
    }, (e) => section.replaceChildren(h("div.ext-section-title", {}, "FORMATS"), h("div.view-error", {}, String(e))));
    return section;
  };

  ctx.subscriptions.push(
    w3.views.register("w3.extensions.installed", {
      actions: [
        { icon: "+", title: "Create Sample Extension", command: "w3.extensions.createSample" },
        { icon: "📁", title: "Open User Extensions Folder", command: "w3.extensions.openFolder" },
        { icon: "⟳", title: "Reload Window", command: "workbench.reload" },
      ],
      render(el) {
        const all = w3.extensions.all();
        const disabledIds = w3.settings.get<string[]>("extensions.disabled", []);
        // The setting may differ from the loaded state until the window is reloaded.
        const pending = all.some((e) => e.disabled !== disabledIds.includes(e.manifest.id));
        const manifests = all.map((e) => e.manifest);
        const nameOf = (id: string) => manifests.find((m) => m.id === id)?.name ?? id;
        const names = (ids: string[]) => ids.map(nameOf).sort((a, b) => a.localeCompare(b)).join(", ");
        const toggle = async (id: string, disable: boolean) => {
          if (disable && id === ctx.extensionId) {
            const c = await w3.window.showWarning("Disabling this view hides these buttons; re-enable via Preferences: Open Settings (JSON). Continue?", "Disable", "Cancel");
            if (c !== "Disable") return;
          }
          // What rests on it stops working; better said now than found out later.
          const users = disable ? neededBy(id, manifests).filter((x) => !disabledIds.includes(x)) : [];
          if (disable && users.length) {
            const c = await w3.window.showWarning(`${nameOf(id)} is needed by ${names(users)}. Without it ${users.length === 1 ? "that stops" : "they stop"} working.`, "Disable anyway", "Cancel");
            if (c !== "Disable anyway") return;
          }
          const next = disable ? [...new Set([...disabledIds, id])] : disabledIds.filter((x) => x !== id);
          await w3.settings.set("extensions.disabled", next);
          w3.views.refresh("w3.extensions.installed");
          const c = await w3.window.showInfo(`${id} will be ${disable ? "disabled" : "enabled"} after a reload.`, "Reload now");
          if (c === "Reload now") location.reload();
        };
        /** What it needs, what needs it, and what's keeping it from working. */
        const depends = (id: string) => {
          const needs = requires(id, manifests), by = neededBy(id, manifests);
          const blocked = disabledIds.includes(id) ? [] : blockedBy(id, manifests, new Set(disabledIds));
          return [
            needs.length ? h("div.ext-deps", {}, `Needs ${names(needs)}`) : null,
            by.length ? h("div.ext-deps", { title: by.map(nameOf).join("\n") }, `Needed by ${by.length <= 3 ? names(by) : `${by.length} extensions`}`) : null,
            blocked.length ? h("div.ext-blocked", {}, `Can't work: ${names(blocked)} is off or missing`) : null,
          ];
        };
        if (pending) el.append(h("div.ext-pending", {}, "Changes apply after reloading.", h("button.link-inline", { onclick: () => location.reload() }, "Reload")));
        el.append(
          h("div.ext-list", {},
            ...all.map((e) => {
              const willDisable = disabledIds.includes(e.manifest.id);
              const state = e.disabled ? "disabled" : e.error ? "failed" : e.active ? "active" : "idle";
              return h(`div.ext-item${e.disabled ? ".is-disabled" : ""}`, {},
                h("div.ext-title", {},
                  h("strong", {}, e.manifest.name),
                  h("small", {}, ` ${e.manifest.version}`),
                  h(`span.badge.${e.source}`, {}, e.source),
                  h(`span.state.${state}`, { title: e.error ?? "" }, state),
                ),
                h("div.ext-id", {}, e.manifest.id),
                e.manifest.description ? h("div.ext-desc", {}, e.manifest.description) : null,
                ...depends(e.manifest.id),
                h("div.ext-actions", {},
                  h("button", { onclick: () => toggle(e.manifest.id, !willDisable) }, willDisable ? "Enable" : "Disable"),
                  willDisable !== e.disabled ? h("small.muted", {}, willDisable ? "disabled after reload" : "enabled after reload") : null),
              );
            }),
          ),
        );
        el.append(renderFormats());
      },
    }),
    w3.commands.register("w3.extensions.openFolder", async () => {
      await w3.backend.invoke("reveal_in_explorer", { path: (await paths()).user_extensions });
    }),
    w3.commands.register("w3.extensions.createSample", async () => {
      const dir = joinPath((await paths()).user_extensions, "sample-hello");
      await w3.backend.invoke("fs_write_text", { path: joinPath(dir, "extension.json"), text: JSON.stringify(SAMPLE_MANIFEST, null, 2) + "\n" });
      await w3.backend.invoke("fs_write_text", { path: joinPath(dir, "main.js"), text: SAMPLE_MAIN });
      const c = await w3.window.showInfo(`Sample extension written to ${dir}. Reload to load it.`, "Reload", "Open Folder");
      if (c === "Reload") location.reload();
      if (c === "Open Folder") await w3.backend.invoke("reveal_in_explorer", { path: dir });
    }),
  );
  // The host marks this extension active only after activate() returns; re-render once so it lists itself as active.
  setTimeout(() => w3.views.refresh("w3.extensions.installed"));
}
