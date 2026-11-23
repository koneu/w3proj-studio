# Extension host

The host that loads and runs extensions. Built-ins live in `../builtin/<name>/`; user and project extensions are plain ES modules loaded from disk.

- `api.ts`: the extension API. `ExtensionManifest` (extension.json: id, name, activationEvents, extensionDependencies, `contributes`: commands, viewContainers, views, editors, services, configuration, mcpTools, keybindings), `W3Api` (what `activate(w3, ctx)` receives), `ExtensionContext`, `ExtensionModule` (`activate`, optional `deactivate`).
- `host.ts`: `ExtensionHost` reads the manifests (built-ins by glob of `../builtin/*/extension.json`), applies contributions, activates an extension lazily on its activation event (a contributed command, view, editor, service or MCP tool implies one) after its dependencies, and logs failures.
- `graph.ts`: which extensions rest on which (from `extensionDependencies`).
- `services.ts`: typed services extensions offer each other (`w3.mcpEdits`, `w3.objects`, `w3.terrain`, `w3.triggers`, ...).
- `mcp.ts`: the MCP tool registry; tools are declared in manifests and listed without loading their extension.
- `lib.ts`: `await w3.lib()`, the parsers, writers and checks for extensions without a build step.
- `colortools.ts`: colour-tag toolbar and preview for text fields.

Every built-in folder has a README.md; `npm run check` fails when one lacks it.
