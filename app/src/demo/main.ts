// The web demo's entry: the fake backend goes in first, then the app's own main.ts runs as it does on the desktop.
import { installTauri } from "./tauri";

installTauri();

const banner = document.createElement("div");
banner.className = "demo-banner";
banner.textContent = "UI demo of the W3Proj Studio desktop app. The project is made up and lives in this page; maps, the game and the terrain need the desktop app.";
document.body.appendChild(banner);

void import("../main");
