# MCP Server

Extension `w3.mcpServer`. The one MCP server through which AI tools use the open project; every extension contributes its own tools.

## Data
Core tools read and edit project files (list_files, read_file, edit_text_file, save_project); keeps an edit list for undo. Writes only when the settings allow it (mcp.writeTools and related). The edit list also carries the files tools keep outside map/ (the reserved areas, AI Editor files as base64 text: edits.ts loggedPath). A client that gives a progress token hears from a tool call every few seconds, with the tool's own counts where it reports them (extensions/mcp.ts CallProgress; the bridge passes the lines on).

## Contributes
- Commands (3): w3.mcp.toggle, w3.mcp.copySetup, w3.mcp.undo
- Views (1): w3.mcp.status
- MCP tools (11): read_guide, list_edits, undo_last_edit, edit_text_file, project_info, studio_status, save_project, begin_edit, and 3 more
- Services (1): w3.mcpEdits
- Settings (7): mcp.enabled, mcp.projectTools, mcp.writeTools, mcp.saveTool, mcp.ignoreUndoSteps, mcp.confirmTileset, and 1 more

Full list: `extension.json` in this folder.
