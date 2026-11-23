// The graphics mode a Problems run used: the checks' answers depend on game.graphicsMode (which model or texture
// version a path resolves to), so the view's header and `w3proj check` name it.

import type { GraphicsMode } from "../../extensions/services";

/** The setting's value as a mode; anything unknown is the app's default (hd), as game.graphicsMode's readers do. */
export function graphicsModeOf(value: unknown): GraphicsMode {
  return value === "sd" || value === "de" ? value : "hd";
}

/** The one line the view's header and the CLI's text output show. */
export const modeLine = (mode: GraphicsMode): string => `Graphics mode: ${mode}`;
