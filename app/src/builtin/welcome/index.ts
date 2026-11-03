import type { ExtensionContext, W3Api } from "../../extensions/api";
import { h } from "../../workbench/dom";

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(
    w3.editors.registerProvider("w3.welcome", {
      resolve(el) {
        const render = () => {
          const recent = w3.settings.get<string[]>("recentProjects", []);
          const action = (label: string, command: string, hint: string) =>
            h("button.link", { onclick: () => w3.commands.execute(command) }, h("span", {}, label), h("small", {}, hint));
          el.replaceChildren(
            h("div.welcome", {},
              h("h1", {}, "W3Proj Studio"),
              h("p.subtitle", {}, "Warcraft III maps as git-friendly projects. Packing to .w3x is the release step."),
              h("div.welcome-columns", {},
                h("section", {},
                  h("h2", {}, "Start"),
                  action("New Map…", "w3.map.new", "an empty map as a new project folder (Ctrl+N)"),
                  action("Import .w3x Map…", "w3.project.importMap", "unpack a map into a new project folder"),
                  action("Open Project Folder…", "w3.project.open", "a folder containing w3proj.toml"),
                  action("Open Settings", "workbench.openSettings", "World Editor and game paths"),
                  action("Command Palette", "workbench.commandPalette", "Ctrl+Shift+P"),
                ),
                h("section", {},
                  h("h2", {}, "Recent"),
                  recent.length
                    ? recent.map((p) => h("button.link", { onclick: () => w3.commands.execute("w3.project.open", p).catch((e) => w3.window.showError(String(e))) },
                        h("span", {}, p.split(/[\\/]/).pop() ?? p), h("small", {}, p)))
                    : h("p.muted", {}, "No recent projects."),
                ),
              ),
              h("section.workflow", {},
                h("h2", {}, "Workflow"),
                h("ol", {},
                  h("li", {}, "Import a .w3x — every file lands in map/, object data as JSON."),
                  h("li", {}, "Commit the project folder to git."),
                  h("li", {}, "Edit scripts and objects here, or run \"Open in World Editor\" (F5). Saves in the World Editor sync back into the project."),
                  h("li", {}, "\"Pack Release .w3x\" (Ctrl+Shift+B) builds the distributable map."),
                ),
              ),
            ),
          );
        };
        render();
        const sub = w3.settings.onDidChange((k) => k === "recentProjects" && render());
        return { dispose: () => sub.dispose() };
      },
    }),
    w3.commands.register("w3.welcome.show", () => w3.editors.open("w3:welcome")),
  );
  if (!w3.workspace.project()) w3.editors.open("w3:welcome");
}
