# Game Data

Extension `w3.gameData`. Browses the installed game's files (models, textures, SLKs, scripts) read-only and sets the game's graphics mode.

## Data
Reads the game's storage through the host (w3.game); writes nothing. MCP tools search and read game files.

## Contributes
- Commands (4): w3.game.openPath, w3.game.info, w3.game.reload, w3.game.setMode
- Views (1): w3.game.files
- MCP tools (2): search_game_files, read_game_file

Full list: `extension.json` in this folder.
