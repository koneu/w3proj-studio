// The app's side of the MCP server: passes requests from the pipe (see src-tauri/src/mcp.rs) to
// w3.mcp, and has the tools about the project itself. What other parts of the editor can do,
// they offer themselves: a terrain screenshot comes from the Terrain Viewer's extension.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { projectPath } from "../../extensions/mcp";

/** One read_file answer; `offset` gets the rest. */
const READ_LIMIT = 200_000;

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

  ctx.subscriptions.push(
    w3.commands.register("w3.mcp.toggle", async () => {
      await w3.settings.set("mcp.enabled", !enabled());
    }),
    w3.commands.register("w3.mcp.copySetup", async () => {
      const bridge = await w3.backend.invoke<string | null>("mcp_bridge_path");
      if (!bridge) throw new Error("w3proj.exe isn't next to this program, so there's nothing for a client to start.");
      await navigator.clipboard.writeText(JSON.stringify({ mcpServers: { w3proj: { command: bridge, args: ["mcp"] } } }, null, 2));
      void w3.window.showInfo("Copied the MCP client setup. Paste it into your client's configuration.");
    }),
    w3.settings.onDidChange((key) => { if (key === "mcp.enabled") void apply(); }),

    w3.mcp.registerTool("project_info", () => {
      const project = open();
      return { name: project.name, folder: project.root, files: w3.workspace.files().length, activeFile: w3.editors.activePath() };
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
