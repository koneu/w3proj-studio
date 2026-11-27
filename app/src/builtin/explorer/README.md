# Explorer

Extension `w3.explorer`. File tree of the open project: the files on disk.

The app's file list has more: virtual files (`FileInfo.virtual`) that its editors read and write, such as a split
terrain's single terrain and placed-object files, the flat object files, and the generated files that are really in
`build/derived/`. The Explorer and Go to File leave them out (`lib/projectview.ts`). Clicking
`map/terrain/terrain.json` opens the terrain editor (**Open With…** shows the file). `build/` is hidden; the view's ◫
button (setting `explorer.showBuild`) shows it, its files where they are.

## Data
Reads the project's folder listing; creates, renames, deletes and opens project files and folders. Writes no map data by itself.

## Contributes
- Commands (6): w3.explorer.refresh, w3.explorer.newFolder, w3.explorer.newFile, w3.explorer.collapseAll, w3.explorer.toggleBuild, w3.explorer.focus
- Views (1): w3.explorer.files
- Settings (1): explorer.showBuild

Full list: `extension.json` in this folder.
