import type { ExtensionContext, W3Api } from "../../extensions/api";
import { checkGameFolder } from "./gamefolder";

export function activate(w3: W3Api, ctx: ExtensionContext) {
  // Asks for the game's folder if the configured one doesn't open (the first start on Linux, or another drive).
  // After the start, so nothing waits on it.
  setTimeout(() => void checkGameFolder(w3).catch(() => {}), 0);
  ctx.subscriptions.push(
    // Asked even when the current folder opens: the user wants another one.
    w3.commands.register("w3.game.chooseFolder", () => checkGameFolder(w3, true)),
  );
}
