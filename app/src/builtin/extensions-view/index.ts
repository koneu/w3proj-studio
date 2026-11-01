import type { ExtensionContext, W3Api } from "../../extensions/api";
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

  ctx.subscriptions.push(
    w3.views.register("w3.extensions.installed", {
      actions: [
        { icon: "+", title: "Create Sample Extension", command: "w3.extensions.createSample" },
        { icon: "📁", title: "Open User Extensions Folder", command: "w3.extensions.openFolder" },
        { icon: "⟳", title: "Reload Window", command: "workbench.reload" },
      ],
      render(el) {
        const all = w3.extensions.all();
        el.append(
          h("div.ext-list", {},
            ...all.map((e) =>
              h("div.ext-item", {},
                h("div.ext-title", {},
                  h("strong", {}, e.manifest.name),
                  h("small", {}, ` ${e.manifest.version}`),
                  h(`span.badge.${e.source}`, {}, e.source),
                  h(`span.state${e.error ? ".error" : e.active ? ".active" : ""}`, { title: e.error ?? "" }, e.error ? "failed" : e.active ? "active" : "idle"),
                ),
                h("div.ext-id", {}, e.manifest.id),
                e.manifest.description ? h("div.ext-desc", {}, e.manifest.description) : null,
              ),
            ),
          ),
        );
      },
    }),
    w3.commands.register("w3.extensions.openFolder", async () => {
      await w3.backend.invoke("reveal_in_explorer", { path: (await paths()).user_extensions });
    }),
    w3.commands.register("w3.extensions.createSample", async () => {
      const dir = `${(await paths()).user_extensions}\\sample-hello`;
      await w3.backend.invoke("fs_write_text", { path: `${dir}\\extension.json`, text: JSON.stringify(SAMPLE_MANIFEST, null, 2) + "\n" });
      await w3.backend.invoke("fs_write_text", { path: `${dir}\\main.js`, text: SAMPLE_MAIN });
      const c = await w3.window.showInfo(`Sample extension written to ${dir}. Reload to load it.`, "Reload", "Open Folder");
      if (c === "Reload") location.reload();
      if (c === "Open Folder") await w3.backend.invoke("reveal_in_explorer", { path: dir });
    }),
  );
}
