// The app's side of the MCP server: passes requests from the pipe (see src-tauri/src/mcp.rs) to
// w3.mcp, and has the tools about the project itself. What other parts of the editor can do,
// they offer themselves: a terrain screenshot comes from the Terrain Viewer's extension.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { projectPath } from "../../extensions/mcp";
import { MCP_EDITS_SERVICE, type McpEditsService } from "../../extensions/services";
import { h } from "../../workbench/dom";
import { editablePath, EditLog } from "./edits";
import { GUIDES } from "./guides";
import { isTerrainText, w3eFromText } from "../../lib/terrain/w3etext";

/** One read_file answer; `offset` gets the rest. */
const READ_LIMIT = 200_000;

interface ClientInfo { id: string; name: string; path: string; found: boolean; configured: boolean }
interface SetupResult { path: string; changed: boolean; backup: string | null }

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const status = w3.statusBar.add({ id: "w3.mcp.status", text: "", command: "w3.mcp.toggle", align: "right", tooltip: "MCP server is on: AI clients on this computer can use the open project. Click to turn it off." });
  const enabled = () => w3.settings.get<boolean>("mcp.enabled", false) === true;

  /** Opens or closes the pipe to match the setting. */
  const apply = async () => {
    const on = enabled();
    try {
      await w3.backend.invoke("mcp_serve", { enabled: on });
      status.text = on ? "MCP" : "";
    } catch (e) {
      status.text = "";
      void w3.window.showError(`MCP server: ${e}`);
    }
  };

  const open = () => {
    const project = w3.workspace.project();
    if (!project) throw new Error("No project is open in W3Proj Studio.");
    return project;
  };

  const out = w3.output.channel("MCP");
  const log = new EditLog({
    read: (path) => w3.workspace.readText(path).catch((e) => {
      if (w3.workspace.files().some((f) => f.path.toLowerCase() === path.toLowerCase())) throw e;
      return null;
    }),
    write: async (path, text) => {
      const isNew = !w3.workspace.files().some((f) => f.path.toLowerCase() === path.toLowerCase());
      if (text === null) await w3.workspace.delete(path); else await w3.workspace.writeText(path, text);
      if (isNew || text === null) await w3.workspace.refresh();
    },
    unsaved: () => w3.editors.unsavedPaths(),
    checkpoint: () => w3.commands.execute("w3.checkpoints.create", { quiet: true }).then(() => undefined),
    log: (line) => out.append(line),
  });
  // Only this part changes with an edit: redrawing the view would flash everything else in it.
  const editList = h("div");
  const showEdits = () => {
    const past = log.history(), canUndo = log.list().at(-1);
    editList.replaceChildren(
      h("div.ext-section-title", {}, "AI EDITS"),
      ...(past.length ? past.slice(0, 6).map((e) => h(`div.ext-desc.ai-edit${e.undone ? ".undone" : ""}`, { title: e.title }, e.title, e.undone ? h("small.muted", {}, " undone") : null)) : [h("div.view-empty", {}, "None yet.")]),
      ...(past.length > 6 ? [h("div.ext-desc.ai-edit.muted", {}, `and ${past.length - 6} earlier`)] : []),
      ...(canUndo ? [h("div.ext-item", {}, h("div.ext-actions", {}, h("button", { onclick: () => void w3.commands.execute("w3.mcp.undo").catch((e) => w3.window.showError(String(e))) }, `Undo "${canUndo.title}"`)))] : []));
  };
  log.onChange = showEdits;
  let root: string | null = w3.workspace.project()?.root ?? null;

  const setting = (key: string) => w3.settings.get<boolean>(key, false) === true;
  /** What's going on, for an AI that can't see the window. Never fails: it's how to find out. */
  const appState = () => {
    const project = w3.workspace.project(), unsaved = w3.editors.unsavedPaths();
    return {
      project: project ? { name: project.name, folder: project.root, files: w3.workspace.files().length } : null,
      activeFile: w3.editors.activePath(), unsaved,
      may: { edit: setting("mcp.writeTools"), save: setting("mcp.saveTool") },
      undoableEdits: log.list().length,
      // A client that stopped halfway leaves one open: its edits still undo as one.
      ...(log.openGroup ? { openGroup: log.openGroup } : {}),
      ...(unsaved.length ? { note: "Reading tools see the last save, not these changes, and edits are refused until they're saved." } : {}),
    };
  };

  const undo = async () => {
    const title = await log.undo();
    return title ? `Undone: ${title}` : "There's no AI edit to undo.";
  };

  /** Writes into another program's configuration, so it asks first, naming the file. */
  const trySetup = async (client: ClientInfo) => {
    const write = "Add it";
    // Not found: nothing would be written, so there's nothing to ask, only the reason to give.
    const asked = client.found ? await w3.window.showWarning(`Add W3Proj Studio to ${client.name}? This changes ${client.path}, and keeps the old file next to it as a backup.`, write, "Cancel") : write;
    if (asked !== write) return;
    try {
      const done = await w3.backend.invoke<SetupResult>("mcp_client_setup", { id: client.id });
      void w3.window.showInfo(done.changed ? `Added to ${client.name}. Restart it to see the tools.` : `${client.name} is already set up.`);
    } catch (e) {
      void w3.window.showError(`Couldn't set up ${client.name}: ${e}`);
    }
    w3.views.refresh("w3.mcp.status");
  };

  const clientRow = (client: ClientInfo) => h("div.ext-item", { title: client.path },
    h("div.ext-title", {}, h("strong", {}, client.name)),
    h("div.ext-desc", {}, client.configured ? "Set up. Restart it if the tools don't show." : client.found ? "Found, not set up yet." : "Not found in the usual place."),
    h("div.ext-actions", {}, h("button", { onclick: () => void trySetup(client) }, `Try to set up for ${client.name}`)));

  ctx.subscriptions.push(
    w3.views.register("w3.mcp.status", {
      render(el) {
        const on = enabled(), writing = setting("mcp.writeTools"), saving = setting("mcp.saveTool");
        const asks = (key: string) => w3.settings.get<boolean>(key, true) !== false;
        /** A big change an AI asks about first, unless the user would rather it didn't. */
        const askRow = (key: string, what: string) => h("div.ext-item", {},
          h("div.ext-desc", {}, asks(key) ? `AI tools ask you before ${what}.` : `AI tools can go ahead with ${what}, after a checkpoint.`),
          h("div.ext-actions", {}, h("button", { onclick: () => void w3.settings.set(key, !asks(key)) }, asks(key) ? "Stop asking" : "Ask first")));
        showEdits();
        el.append(
          h("div.ext-item", {},
            h("div.ext-desc", {}, on ? "On: AI clients on this computer can use the open project." : "Off: AI clients can't reach this app."),
            h("div.ext-actions", {},
              h("button", { onclick: () => void w3.commands.execute("w3.mcp.toggle") }, on ? "Turn off" : "Turn on"),
              h("button", { onclick: () => void w3.commands.execute("w3.mcp.copySetup").catch((e) => w3.window.showError(String(e))) }, "Copy client setup"))),
          h("div.ext-item", {},
            h("div.ext-desc", {}, writing ? "AI tools may change this project. Each change can be undone." : "AI tools can only read this project."),
            h("div.ext-actions", {}, h("button", { onclick: () => void w3.settings.set("mcp.writeTools", !writing) }, writing ? "Read only" : "Allow edits"))),
          ...(writing ? [h("div.ext-item", {},
            h("div.ext-desc", {}, saving ? "AI tools may save everything unsaved, your own work too." : "AI tools ask you to save."),
            h("div.ext-actions", {}, h("button", { onclick: () => void w3.settings.set("mcp.saveTool", !saving) }, saving ? "Stop saving" : "Allow saving")))] : []),
          ...(writing ? [askRow("mcp.confirmTileset", "changing the tileset"), askRow("mcp.confirmResize", "resizing the map")] : []),
          ...(writing ? [editList] : []),
          h("div.ext-section-title", {}, "CLIENTS"),
          h("div.ext-desc.ext-formats-hint", {}, "Looks where a standard installation keeps its settings, so this can fail. Copy client setup always works."));
        const clients = h("div", {}, h("div.view-empty", {}, "Looking…"));
        el.append(clients, h("div.ext-section-title", {}, "TOOLS"),
          h("div", {}, ...w3.mcp.list().map((t) => h("div.ext-item", {}, h("div.ext-title", {}, h("code", {}, t.name)), h("div.ext-desc", {}, t.description)))));
        w3.backend.invoke<ClientInfo[]>("mcp_clients").then((list) => clients.replaceChildren(...list.map(clientRow)),
          (e) => clients.replaceChildren(h("div.view-error", {}, String(e))));
      },
    }),
    w3.services.provide<McpEditsService>(MCP_EDITS_SERVICE, { edit: (title, change, follow) => log.edit(title, change, follow) }),
    w3.workspace.onDidChange(() => {
      const now = w3.workspace.project()?.root ?? null;
      if (now !== root) { root = now; log.reset(); }
    }),
    w3.commands.register("w3.mcp.undo", async () => { void w3.window.showInfo(await undo()); }),
    w3.mcp.registerTool("read_guide", ({ topic }) => {
      if (topic === undefined) return Object.entries(GUIDES).map(([name, guide]) => ({ topic: name, about: guide.summary }));
      const guide = typeof topic === "string" ? GUIDES[topic] : undefined;
      if (!guide) throw new Error(`There's no guide on "${String(topic)}". There are: ${Object.keys(GUIDES).join(", ")}.`);
      return guide.text;
    }),
    w3.mcp.registerTool("list_edits", () => log.list().map((e) => ({ title: e.title, at: new Date(e.at).toISOString(), files: e.files.map((f) => f.path) }))),
    w3.mcp.registerTool("undo_last_edit", undo),
    w3.mcp.registerTool("edit_text_file", async ({ path, find, replace }) => {
      open();
      if (typeof path !== "string" || typeof find !== "string" || typeof replace !== "string" || !find) throw new Error("edit_text_file needs path, find and replace.");
      const file = editablePath(path);
      await log.edit(`Edit ${file}`, async (read) => {
        const text = await read(file);
        if (text === null) throw new Error(`There's no ${file}.`);
        const times = text.split(find).length - 1;
        if (times !== 1) throw new Error(`That text occurs ${times} times in ${file}. It must occur exactly once.`);
        const next = text.replace(find, () => replace);
        if (isTerrainText(file)) {
          // Throws if it isn't terrain any more: better now than when the map is packed.
          w3eFromText(next);
          return [{ path: file, text: next }];
        }
        // JSON forms are packed later: broken ones must not get that far.
        if (/\.json$/i.test(file)) {
          const objects = /\.w3[utabdhq]\.json$/i.test(file);
          const clean = await w3.backend.invoke<string>(objects ? "objects_canonicalize" : "codec_canonicalize", objects ? { name: file, text: next } : { root: open().root, path: file, text: next });
          return [{ path: file, text: clean }];
        }
        return [{ path: file, text: next }];
      });
      return isTerrainText(file)
        ? `Changed ${file}. Objects, pathing, shadows and the minimap don't follow an edit like this: paint_terrain and sculpt_terrain do.`
        : `Changed ${file}.`;
    }),
    w3.commands.register("w3.mcp.toggle", async () => {
      await w3.settings.set("mcp.enabled", !enabled());
    }),
    w3.commands.register("w3.mcp.copySetup", async () => {
      const bridge = await w3.backend.invoke<string | null>("mcp_bridge_path");
      if (!bridge) throw new Error("There's no w3proj.exe next to this program, or it's from before MCP. Build it with: cargo build --release -p w3proj-cli");
      await navigator.clipboard.writeText(JSON.stringify({ mcpServers: { w3proj: { command: bridge, args: ["mcp"] } } }, null, 2));
      void w3.window.showInfo("Copied the MCP client setup. Paste it into your client's configuration.");
    }),
    w3.settings.onDidChange((key) => {
      if (key === "mcp.enabled") void apply();
      if (key.startsWith("mcp.")) w3.views.refresh("w3.mcp.status");
    }),

    w3.mcp.registerTool("project_info", appState),
    w3.mcp.registerTool("studio_status", appState),
    w3.mcp.registerTool("save_project", async () => ({ saved: await w3.editors.saveAll(), stillUnsaved: w3.editors.unsavedPaths() })),
    w3.mcp.registerTool("begin_edit", async ({ title }) => {
      if (typeof title !== "string" || !title.trim()) throw new Error("begin_edit needs a title.");
      open();
      await log.beginGroup(title.trim());
      return `Until end_edit, edits count as "${title.trim()}".`;
    }),
    w3.mcp.registerTool("end_edit", async () => {
      const ended = await log.endGroup();
      return ended ? `"${ended.title}" is one edit now, with ${ended.files} file${ended.files === 1 ? "" : "s"} changed.` : "No group was open.";
    }),
    w3.mcp.registerTool("list_files", ({ filter, limit }) => {
      open();
      const text = typeof filter === "string" ? filter.toLowerCase() : "";
      const found = w3.workspace.files().filter((f) => f.path.toLowerCase().includes(text));
      const most = typeof limit === "number" && limit > 0 ? limit : 500;
      return { total: found.length, files: found.slice(0, most).map((f) => ({ path: f.path, size: f.size })) };
    }),
    w3.mcp.registerTool("read_file", async ({ path, offset }) => {
      open();
      if (typeof path !== "string") throw new Error("read_file needs a path.");
      const file = projectPath(path);
      const text = await w3.workspace.readText(file).catch((e) => {
        throw new Error(e?.name === "NotUtf8Error" ? `${file} is a binary file.` : `Can't read ${file}: ${e}`);
      });
      const start = typeof offset === "number" && offset > 0 ? offset : 0;
      const part = text.slice(start, start + READ_LIMIT);
      const rest = text.length - start - part.length;
      return rest > 0 ? `${part}\n\n[${rest} more characters: read on with offset ${start + part.length}]` : part;
    }),
  );

  // Requests only arrive once the pipe is open, so the listener comes first.
  void w3.backend.listen<{ key: number; message: string }>("w3://mcp-request", ({ key, message }) => {
    void w3.mcp.handle(message).then((reply) => w3.backend.invoke("mcp_respond", { key, message: reply }));
  }).then((listener) => { ctx.subscriptions.push(listener); return apply(); });
}

export function deactivate() {}
