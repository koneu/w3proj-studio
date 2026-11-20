# Web demo

A build of the UI that runs in a browser as a static site, to show what the desktop app looks like. It has no Tauri,
no game data and opens no real maps. Everything in it is made up (`app/src/demo/sample/`); nothing from Warcraft III is
shipped. The site: https://koneu.github.io/w3proj-studio/ (deployed by `.github/workflows/demo.yml` on a push to
master; Pages must be enabled once in the repository settings).

    cd app
    npm run dev:demo      # http://localhost:1421/
    npm run build:demo    # app/dist-demo/ (base /w3proj-studio/; DEMO_BASE=/ overrides it)
    npm run demo-check    # serves dist-demo under /w3proj-studio/ and drives it in headless Chrome/Edge, ~15 s
                          # (a step of the commit gate as `demo`, which builds first; CI's Windows job runs it too;
                          # no browser found = FAIL)

## Where the frontend reaches the backend

Everything goes through Tauri's IPC, so one fake of it covers all of it; the app's code runs unchanged.

- `src/workbench/backend.ts`: `invoke`, `listen` (the `plugin:event|listen` command), `readBytes`, `readText`,
  `writeText`, `writeBytes` (`fs_write_bytes`: raw body, path in a header). Used by `workspace.ts`, `workbench.ts`,
  `game.ts`, `trackedinvoke.ts` and nearly every built-in extension (`w3.backend.invoke`): about 55 commands (`fs_*`,
  `project_*`, `game_*`, `codec_*`, `objects_*`, `mcp_*`, `git_*`, `tool_run`, `world_editor_open`, ...).
- `src/workbench/workbench.ts`: `@tauri-apps/plugin-dialog` (`plugin:dialog|open`, `|save`), also over IPC.
- `src/workbench/titlebar.ts`: `getCurrentWindow()` (minimize, maximize, close, close-requested guard, drag region).
  This is the only module that needs a real window.
- `src/headless/ipc.ts`: the same IPC over stdin/stdout for `w3proj rebuild` in Node; not part of the browser build.

What breaks without the Rust side: the game (`game_*`: models, textures, data tables, trigger definitions, the
terrain viewer's meshes), the map codecs (`codec_*`: `.w3e`, `.doo` and so on), pack and unpack, the MCP server, git,
running programs, native dialogs, and the title bar's window buttons.

## How the demo does it (no `is demo` branches in shared code)

- `app/vite.demo.config.ts`: a separate config. A plugin swaps `workbench/titlebar.ts` for `src/demo/titlebar.ts` (menus
  and command box, no window buttons). The desktop build (`vite.config.ts`, `index.html`) is untouched.
- `app/demo.html` and `src/demo/main.ts`: install `window.__TAURI_INTERNALS__` from `src/demo/tauri.ts`, add the banner,
  then load the app's own `main.ts`.
- `src/demo/tauri.ts`: an in-memory file system holding the sample project (trigger, object, map info and script files in
  the unpacked project format, plus text files), project listing, settings that open it at start. Edits live in the page
  until it is reloaded. Every other command rejects with "This needs the desktop app: it isn't available in the web
  demo." (`window.__w3demoRefused` counts them), which the app shows as it does any failed command.
- `src/demo/gamedata/`: made-up trigger definitions (`TriggerData.txt`, `TriggerStrings.txt`, `WorldEditStrings.txt`: a
  few categories, about 25 events, conditions, actions and calls, types, presets and strings, with invented names such as
  "Demo Action - Show message") in the same file format the Trigger Editor's parser reads for the game's files.
  `game_read` answers those three `UI/` paths and refuses every other game file. The sample `war3map.wtg.json` uses them.
- The empty editor area shows `src/demo/terrain-preview.svg` (drawn for the demo) where the terrain would be.

What the demo shows: the layout, side bar views, tabs, menus, command palette, panels, status bar, themes, the extension
view, and the editors that run on plain project files (Map Info, Object Editor with raw ids, text and script editors), and the Trigger
Editor on the made-up definitions (tree with folding, a trigger's events, conditions and actions, the parameter and
function pickers, variables). What needs real game data still says it needs the desktop app: object names and icons,
the terrain, models and textures. `demo-check` opens the trigger file, looks at the tree, a trigger's parts and folding.
